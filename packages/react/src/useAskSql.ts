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

/** Driver prefixes that name a pooled connection rather than the problem. */
const DRIVER_NOISE = /^\s*(?:\(conn=\d+\)|error:)\s*/i;

/** The database's own words after the friendly line. Only local transports carry `detail`. */
function dbErrorMessage(e: { code?: string; userMessage?: string; detail?: string }): string {
  const base = e.userMessage ?? 'The query failed.';
  if (e.code !== 'DB_QUERY_ERROR' || typeof e.detail !== 'string') return base;
  const detail = e.detail.split('\n')[0]?.replace(DRIVER_NOISE, '').trim().slice(0, 300);
  return detail ? `${base} ${detail}` : base;
}

export interface Turn {
  readonly id: string;
  readonly question: string;
  phase: TurnPhase;
  stage?: string;
  sql?: string;
  /** MongoDB only: the collection `sql` (an aggregation pipeline) runs against. */
  collection?: string;
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
  schemaAnswer?: {
    answer: string;
    grounded: boolean;
    unknownReferences: string[];
    isSchemaChange: boolean;
    proposedSql?: string;
  };
}

export interface UseAskSqlOptions {
  readonly transport: Transport;
  readonly connectionId?: string;
  /**
   * Require a human approval click before generated SQL runs. Off by default;
   * set true to gate every query behind a Run button.
   */
  readonly requireApproval?: boolean;
  /**
   * Answer questions that can't become SQL in plain language from the schema
   * structure, never data values. Off by default.
   */
  readonly answerSchemaQuestions?: boolean;
  /**
   * Row cap for every query this hook runs, sent with the request so it applies
   * to a sidecar too.
   */
  readonly maxRows?: number;
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

/** EXPLAIN's shape varies by engine: DuckDB key/value rows, Postgres a single "QUERY PLAN" column, MySQL a wide table. Prefer the plan-text column; fall back to joining all cells. */
export function formatPlan(res: ResultSet): string {
  const planCol = res.columns.findIndex((c) => /^(explain_value|query plan|plan)$/i.test(c.name));
  const cell = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  if (planCol !== -1) {
    return res.rows
      .map((r) => cell(r[planCol]))
      .filter((t) => t.trim() !== '')
      .join('\n')
      .trim();
  }
  return res.rows
    .map((r) => r.map(cell).join(' '))
    .join('\n')
    .trim();
}

export function useAskSql(opts: UseAskSqlOptions): UseAskSqlResult {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Always-current view of turns, so callbacks read a question without re-subscribing.
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  // Synchronous in-flight gate: `busy` is state and lands a tick late, so clicks in one frame race.
  // Holds the token of the run that owns it, so a superseded run releases nothing.
  const inFlightRef = useRef<object | null>(null);

  const patch = useCallback((id: string, update: Partial<Turn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...update } : t)));
  }, []);

  const doRun = useCallback(
    async (turnId: string, sql: string, collection?: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      patch(turnId, { phase: 'running', error: undefined, suggestedSql: undefined });
      try {
        const turn = turnsRef.current.find((t) => t.id === turnId);
        // `collection` is passed in: auto-run fires before React re-renders, so turnsRef is pre-patch.
        const runCollection = collection ?? turn?.collection;
        const result = await opts.transport.execute(sql, {
          connectionId: opts.connectionId,
          question: turn?.question,
          ...(runCollection ? { collection: runCollection } : {}),
          ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
          signal: controller.signal,
        });
        patch(turnId, { phase: 'done', result });
      } catch (err) {
        const e = err as {
          name?: string;
          code?: string;
          userMessage?: string;
          detail?: string;
          retryable?: boolean;
          suggestedSql?: string;
        };
        // A user Stop aborts the fetch; surface a neutral stopped state, not a red error.
        if (e.name === 'AbortError' || controller.signal.aborted) {
          patch(turnId, { phase: 'stopped', error: undefined });
        } else {
          patch(turnId, {
            phase: 'error',
            error: {
              code: e.code ?? 'DB_QUERY_ERROR',
              userMessage: dbErrorMessage(e),
              retryable: e.retryable ?? false,
            },
            suggestedSql: typeof e.suggestedSql === 'string' ? e.suggestedSql : undefined,
          });
        }
      } finally {
        // Only the owner clears it: a Stop plus a new turn can leave this one still unwinding.
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [opts.transport, opts.connectionId, patch],
  );

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || inFlightRef.current) return;
      const token = {};
      inFlightRef.current = token;
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
      let generatedCollection: string | undefined;
      let askErrorCode: string | undefined;
      // Whether the stream left the turn in a state the UI can render.
      let settled = false;
      try {
        for await (const ev of opts.transport.chat({
          question: q,
          connectionId: opts.connectionId,
          context,
          signal: controller.signal,
        })) {
          applyEvent(id, ev);
          if (ev.type === 'sql') {
            generatedSql = ev.sql;
            generatedCollection = ev.collection;
            settled = true;
          } else if (ev.type === 'error') {
            askErrorCode = ev.code;
            settled = true;
          }
        }
      } catch (err) {
        const e = err as { name?: string; code?: string; userMessage?: string; retryable?: boolean };
        askErrorCode = e.code;
        settled = true;
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
      }

      // A stream that ends with neither SQL nor an error would leave the turn spinning forever.
      if (!settled) {
        if (controller.signal.aborted) patch(id, { phase: 'stopped', error: undefined });
        else
          patch(id, {
            phase: 'error',
            error: {
              code: 'LLM_UNAVAILABLE',
              userMessage: 'The response ended before an answer arrived.',
              retryable: true,
            },
          });
      }

      // Schema-understanding fallback: with no SQL and the option on, answer from the schema in prose.
      if (
        !generatedSql &&
        opts.answerSchemaQuestions &&
        (askErrorCode === 'LLM_BAD_OUTPUT' || askErrorCode === 'LLM_REFUSAL')
      ) {
        try {
          const sa = await opts.transport.explainSchema(q, opts.connectionId, context, controller.signal);
          patch(id, {
            phase: 'done',
            error: undefined,
            // Recorded as this turn's sql too, so a follow-up like "run that" has it as context.
            ...(sa.proposedSql ? { sql: sa.proposedSql } : {}),
            schemaAnswer: {
              answer: sa.answer,
              grounded: sa.grounded,
              unknownReferences: [...sa.unknownReferences],
              isSchemaChange: sa.isSchemaChange,
              ...(sa.proposedSql ? { proposedSql: sa.proposedSql } : {}),
            },
          });
        } catch {
          /* keep the original error */
        }
      }
      // Cleared after the fallback, so Stop still reaches it; only the owner clears it, because a
      // Stop plus a new question can leave this turn unwinding behind the next one.
      if (abortRef.current === controller) abortRef.current = null;
      // Stay busy across the auto-run so Stop stays available; skip a query the user just cancelled.
      if (generatedSql && !opts.requireApproval && !controller.signal.aborted) {
        await doRun(id, generatedSql, generatedCollection);
      }
      if (inFlightRef.current === token) {
        setBusy(false);
        inFlightRef.current = null;
      }

      function applyEvent(turnId: string, ev: ChatEvent) {
        if (ev.type === 'stage') patch(turnId, { stage: ev.stage });
        else if (ev.type === 'sql')
          patch(turnId, {
            phase: 'sql_ready',
            sql: ev.sql,
            explanation: ev.explanation,
            autoLimited: ev.autoLimited,
            ...(ev.collection ? { collection: ev.collection } : {}),
          });
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
      const token = {};
      inFlightRef.current = token;
      setBusy(true);
      try {
        await doRun(turnId, turn.sql);
      } finally {
        if (inFlightRef.current === token) {
          setBusy(false);
          inFlightRef.current = null;
        }
      }
    },
    [turns, doRun],
  );

  const editSql = useCallback(
    (turnId: string, sql: string) => {
      // Back to a runnable state; auto-run mode runs it now, approval mode waits behind Run.
      patch(turnId, { sql, phase: 'sql_ready', result: undefined, error: undefined, suggestedSql: undefined });
      if (!opts.requireApproval && !inFlightRef.current) {
        const token = {};
        inFlightRef.current = token;
        setBusy(true);
        void doRun(turnId, sql).finally(() => {
          if (inFlightRef.current === token) {
            setBusy(false);
            inFlightRef.current = null;
          }
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
        // Skip dialects without a bare EXPLAIN (Oracle needs EXPLAIN PLAN FOR); absent capabilities, try it.
        const conns = await opts.transport.listConnections().catch(() => []);
        const conn = conns.find((c) => c.id === opts.connectionId) ?? conns[0];
        if (conn?.capabilities?.supportsExplain === false) {
          patch(turnId, { plan: 'Query plans are not available for this connection.', planning: false });
          return;
        }
        // EXPLAIN passes the guard (read-only); reuse the execute path.
        const res = await opts.transport.execute(`EXPLAIN ${turn.sql}`, { connectionId: opts.connectionId });
        patch(turnId, { plan: formatPlan(res) || '(no plan returned)', planning: false });
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
    inFlightRef.current = null;
    setBusy(false);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = null;
    setTurns([]);
    setBusy(false);
  }, []);

  return useMemo(
    () => ({ turns, busy, ask, run, editSql, planFor, cancel, reset }),
    [turns, busy, ask, run, editSql, planFor, cancel, reset],
  );
}
