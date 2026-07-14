/**
 * useAskSql - the headless engine behind both surfaces. Owns the
 * conversation, the ask->approve->run state machine, streaming status, and
 * error state. Components render from this; hosts can call it directly to
 * build a custom UI.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ResultSet } from '@asksql/core';
import type { ChatEvent, Transport } from './client.js';

export type TurnPhase =
  | 'idle'
  | 'thinking'
  | 'sql_ready'
  | 'running'
  | 'done'
  | 'error';

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
}

let turnSeq = 0;

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
      setTurns((prev) => prev.map((t) => (t.id === id ? {...t,...update } : t)));
  }, []);

  const doRun = useCallback(
    async (turnId: string, sql: string) => {
      patch(turnId, { phase: 'running', error: undefined, suggestedSql: undefined });
      try {
        const controller = new AbortController();
        abortRef.current = controller;
        const result = await opts.transport.execute(sql, {
          connectionId: opts.connectionId,
          question: turnsRef.current.find((t) => t.id === turnId)?.question,
          signal: controller.signal,
        });
        patch(turnId, { phase: 'done', result });
      } catch (err) {
        const e = err as { code?: string; userMessage?: string; retryable?: boolean; suggestedSql?: string };
        patch(turnId, {
          phase: 'error',
          error: { code: e.code ?? 'DB_QUERY_ERROR', userMessage: e.userMessage ?? 'The query failed.', retryable: e.retryable ?? false },
          suggestedSql: typeof e.suggestedSql === 'string' ? e.suggestedSql : undefined,
        });
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
        .slice(-4)
        .map((t) => ({ question: t.question, sql: t.sql! }));
      setTurns((prev) => [...prev, { id, question: q, phase: 'thinking' }]);
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;

      let generatedSql: string | undefined;
      try {
        for await (const ev of opts.transport.chat({ question: q, connectionId: opts.connectionId, context, signal: controller.signal })) {
          applyEvent(id, ev);
          if (ev.type === 'sql') generatedSql = ev.sql;
        }
      } catch (err) {
        const e = err as { code?: string; userMessage?: string; retryable?: boolean };
        patch(id, { phase: 'error', error: { code: e.code ?? 'LLM_UNAVAILABLE', userMessage: e.userMessage ?? 'Something went wrong.', retryable: e.retryable ?? false } });
      } finally {
        abortRef.current = null;
        setBusy(false);
      }

      if (generatedSql && !opts.requireApproval) {
        await doRun(id, generatedSql);
      }
      inFlightRef.current = false;

      function applyEvent(turnId: string, ev: ChatEvent) {
        if (ev.type === 'stage') patch(turnId, { stage: ev.stage });
        else if (ev.type === 'sql') patch(turnId, { phase: 'sql_ready', sql: ev.sql, explanation: ev.explanation, autoLimited: ev.autoLimited });
        else if (ev.type === 'error') patch(turnId, { phase: 'error', error: { code: ev.code ?? 'LLM_UNAVAILABLE', userMessage: ev.userMessage ?? 'Something went wrong.', retryable: ev.retryable ?? false } });
      }
    },
    [turns, opts.transport, opts.connectionId, opts.requireApproval, patch, doRun],
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
    // Reset the turn to a runnable state with the edited SQL; the guard
    // re-validates it on run (a hand-written write is still blocked). In
    // auto-run mode the edit runs immediately (results appear without an extra
    // click); in approval mode it waits behind the Run button.
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

return useMemo(() => ({ turns, busy, ask, run, editSql, planFor, cancel, reset }), [turns, busy, ask, run, editSql, planFor, cancel, reset]);
}
