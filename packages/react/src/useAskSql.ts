/**
 * useAskSql - the headless engine behind both surfaces. Owns the
 * conversation, the ask->approve->run state machine, streaming status, and
 * error state. Components render from this; hosts can call it directly to
 * build a custom UI.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ResultSet } from '@asksql/core';
import type { ChatEvent, Transport } from './client.js';

export type TurnPhase = 'idle' | 'thinking' | 'sql_ready' | 'running' | 'done' | 'error' | 'stopped';

export interface Turn {
  readonly id: string;
  readonly question: string;
  phase: TurnPhase;
  stage?: string;
  sql?: string;
  explanation?: string;
  autoLimited?: boolean;
  result?: ResultSet;
  /** EXPLAIN-plan text, populated on demand. */
  plan?: string;
  planning?: boolean;
  error?: { code: string; userMessage: string; retryable: boolean };
  /** A corrected query the server suggested after a failed run (apply to retry). */
  suggestedSql?: string;
  /** A grounded plain-language schema answer, when the question wasn't a data query (see answerSchemaQuestions). */
  schemaAnswer?: { answer: string; grounded: boolean; unknownReferences: string[]; isSchemaChange: boolean };
}

export interface UseAskSqlOptions {
  readonly transport: Transport;
  readonly connectionId?: string;
  /**
   * Require a human approval click before generated SQL runs. Off by default,
   * so results appear automatically; set true to gate every query behind a
   * Run button (the SQL and its explanation are always shown first regardless).
   */
  readonly requireApproval?: boolean;
  /**
   * When a question can't be turned into a SQL query, answer it in plain language
   * from the schema instead of showing an error. Grounded in structure only, never
   * data values. Off by default.
   */
  readonly answerSchemaQuestions?: boolean;
}

let turnSeq = 0;

/** Prior answered turns sent with a question for follow-up context. */
const CONTEXT_TURNS = 4;

export interface UseAskSqlResult {
  readonly turns: readonly Turn[];
  readonly busy: boolean;
  ask(question: string): Promise<void>;
  run(turnId: string): Promise<void>;
  /** Replace a turn's SQL (manual edit) - re-guarded on run. */
  editSql(turnId: string, sql: string): void;
  /** Fetch the query plan (EXPLAIN) for a turn's SQL. */
  planFor(turnId: string): Promise<void>;
  cancel(): void;
  reset(): void;
}

export function useAskSql(opts: UseAskSqlOptions): UseAskSqlResult {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Always-current view of turns, so callbacks can read a turn's question
  // without re-subscribing (avoids stale closures / dep churn).
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  // Synchronous in-flight gate. `busy` is React state and updates a tick late,
  // so several Retry buttons clicked in the same frame would all read
  // busy===false and fire together. This ref flips synchronously, so only the
  // first click of a batch runs; the rest are no-ops until it settles.
  const inFlightRef = useRef(false);

  const patch = useCallback((id: string, update: Partial<Turn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...update } : t)));
  }, []);

  const doRun = useCallback(
    async (turnId: string, sql: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      patch(turnId, { phase: 'running', error: undefined, suggestedSql: undefined });
      try {
        const result = await opts.transport.execute(sql, {
          connectionId: opts.connectionId,
          question: turnsRef.current.find((t) => t.id === turnId)?.question,
          signal: controller.signal,
        });
        patch(turnId, { phase: 'done', result });
      } catch (err) {
        const e = err as { name?: string; code?: string; userMessage?: string; retryable?: boolean; suggestedSql?: string };
        // A user Stop aborts the fetch; surface a neutral stopped state, not a red error.
        if (e.name === 'AbortError' || controller.signal.aborted) {
          patch(turnId, { phase: 'stopped', error: undefined });
        } else {
          patch(turnId, {
            phase: 'error',
            error: {
              code: e.code ?? 'DB_QUERY_ERROR',
              userMessage: e.userMessage ?? 'The query failed.',
              retryable: e.retryable ?? false,
            },
            suggestedSql: typeof e.suggestedSql === 'string' ? e.suggestedSql : undefined,
          });
        }
      } finally {
        abortRef.current = null;
      }
    },
    [opts.transport, opts.connectionId, patch],
  );

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || inFlightRef.current) return;
      inFlightRef.current = true;
      const id = `turn_${++turnSeq}`;
      const context = turns
        .filter((t) => t.sql)
        .slice(-CONTEXT_TURNS)
        .map((t) => ({ question: t.question, sql: t.sql! }));
      setTurns((prev) => [...prev, { id, question: q, phase: 'thinking' }]);
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;

      let generatedSql: string | undefined;
      let askErrorCode: string | undefined;
      try {
        for await (const ev of opts.transport.chat({
          question: q,
          connectionId: opts.connectionId,
          context,
          signal: controller.signal,
        })) {
          applyEvent(id, ev);
          if (ev.type === 'sql') generatedSql = ev.sql;
          else if (ev.type === 'error') askErrorCode = ev.code;
        }
      } catch (err) {
        const e = err as { name?: string; code?: string; userMessage?: string; retryable?: boolean };
        askErrorCode = e.code;
        // A user Stop aborts the stream; surface a neutral stopped state, not a red error.
        if (e.name === 'AbortError' || controller.signal.aborted) {
          patch(id, { phase: 'stopped', error: undefined });
        } else {
          patch(id, {
            phase: 'error',
            error: {
              code: e.code ?? 'LLM_UNAVAILABLE',
              userMessage: e.userMessage ?? 'Something went wrong.',
              retryable: e.retryable ?? false,
            },
          });
        }
      } finally {
        abortRef.current = null;
      }

      // Schema-understanding fallback: when no SQL could be built and the option is on,
      // answer the question from the schema in prose instead of leaving an error.
      if (
        !generatedSql &&
        opts.answerSchemaQuestions &&
        (askErrorCode === 'LLM_BAD_OUTPUT' || askErrorCode === 'LLM_REFUSAL')
      ) {
        try {
          const sa = await opts.transport.explainSchema(q, opts.connectionId);
          patch(id, {
            phase: 'done',
            error: undefined,
            schemaAnswer: {
              answer: sa.answer,
              grounded: sa.grounded,
              unknownReferences: [...sa.unknownReferences],
              isSchemaChange: sa.isSchemaChange,
            },
          });
        } catch {
          /* keep the original error */
        }
      }
      // Keep busy across the auto-run so Stop stays available and typed input isn't
      // discarded mid-execute; don't run a query the user just cancelled.
      if (generatedSql && !opts.requireApproval && !controller.signal.aborted) {
        await doRun(id, generatedSql);
      }
      setBusy(false);
      inFlightRef.current = false;

      function applyEvent(turnId: string, ev: ChatEvent) {
        if (ev.type === 'stage') patch(turnId, { stage: ev.stage });
        else if (ev.type === 'sql')
          patch(turnId, { phase: 'sql_ready', sql: ev.sql, explanation: ev.explanation, autoLimited: ev.autoLimited });
        else if (ev.type === 'error')
          patch(turnId, {
            phase: 'error',
            error: {
              code: ev.code ?? 'LLM_UNAVAILABLE',
              userMessage: ev.userMessage ?? 'Something went wrong.',
              retryable: ev.retryable ?? false,
            },
          });
      }
    },
    [turns, opts.transport, opts.connectionId, opts.requireApproval, opts.answerSchemaQuestions, patch, doRun],
  );

  const run = useCallback(
    async (turnId: string) => {
      const turn = turns.find((t) => t.id === turnId);
      if (!turn?.sql || inFlightRef.current) return;
      inFlightRef.current = true;
      setBusy(true);
      try {
        await doRun(turnId, turn.sql);
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [turns, doRun],
  );

  const editSql = useCallback(
    (turnId: string, sql: string) => {
      // Back to a runnable state; the guard re-validates on run. Auto-run mode runs it now,
      // approval mode waits behind the Run button.
      patch(turnId, { sql, phase: 'sql_ready', result: undefined, error: undefined });
      if (!opts.requireApproval && !inFlightRef.current) {
        inFlightRef.current = true;
        setBusy(true);
        void doRun(turnId, sql).finally(() => {
          setBusy(false);
          inFlightRef.current = false;
        });
      }
    },
    [patch, opts.requireApproval, doRun],
  );

  const planFor = useCallback(
    async (turnId: string) => {
      const turn = turns.find((t) => t.id === turnId);
      if (!turn?.sql) return;
      patch(turnId, { planning: true });
      try {
        // Skip on dialects without a bare EXPLAIN (e.g. Oracle needs EXPLAIN PLAN FOR + a follow-up
        // query); a hardcoded EXPLAIN would just error. Absent capabilities -> attempt it as before.
        const conns = await opts.transport.listConnections().catch(() => []);
        const conn = conns.find((c) => c.id === opts.connectionId) ?? conns[0];
        if (conn?.capabilities?.supportsExplain === false) {
          patch(turnId, { plan: 'Query plans are not available for this connection.', planning: false });
          return;
        }
        // EXPLAIN passes the guard (read-only); reuse the execute path.
        const res = await opts.transport.execute(`EXPLAIN ${turn.sql}`, { connectionId: opts.connectionId });
        const text = res.rows.map((r) => r.map((c) => (c === null ? '' : String(c))).join(' ')).join('\n');
        patch(turnId, { plan: text || '(no plan returned)', planning: false });
      } catch (err) {
        const e = err as { userMessage?: string };
        patch(turnId, { plan: `Couldn't fetch the plan: ${e.userMessage ?? 'error'}`, planning: false });
      }
    },
    [turns, opts.transport, opts.connectionId, patch],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    setBusy(false);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    inFlightRef.current = false;
    setTurns([]);
    setBusy(false);
  }, []);

  return useMemo(
    () => ({ turns, busy, ask, run, editSql, planFor, cancel, reset }),
    [turns, busy, ask, run, editSql, planFor, cancel, reset],
  );
}
