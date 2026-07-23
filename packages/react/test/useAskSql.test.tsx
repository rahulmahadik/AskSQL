// @vitest-environment jsdom
/**
 * useAskSql state machine: ask -> approve -> run, streaming phases, manual
 * edit, EXPLAIN plans, cancel, and error handling (stream + run failures).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAskSql } from '../src/useAskSql.js';
import type { AskParams, ChatEvent } from '../src/client.js';
import { chatOf, deferred, makeTransport, resultOf } from './helpers.js';

afterEach(cleanup);

describe('useAskSql', () => {
  it('ask auto-runs: thinking -> sql_ready -> done with result', async () => {
    const transport = makeTransport({
      chat: chatOf({ type: 'stage', stage: 'llm' }, { type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
      execute: async () => resultOf({ rowCount: 1, rows: [['EU', 1]] }),
    });
    const { result } = renderHook(() => useAskSql({ transport }));

    await act(async () => {
      await result.current.ask('how many?');
    });

    const turn = result.current.turns[0]!;
    expect(turn.question).toBe('how many?');
    expect(turn.sql).toBe('SELECT 1');
    expect(turn.phase).toBe('done');
    expect(turn.result?.rowCount).toBe(1);
    expect(result.current.busy).toBe(false);
  });

  it('falls back to a schema answer when SQL fails and answerSchemaQuestions is on', async () => {
    const explainSchema = vi.fn(async () => ({
      answer: 'orders links to customers via customer_id.',
      tables: ['orders'],
      grounded: true,
      unknownReferences: [] as string[],
      isSchemaChange: false,
    }));
    const transport = makeTransport({
      chat: chatOf({ type: 'error', code: 'LLM_BAD_OUTPUT', userMessage: "couldn't build a query" }),
      explainSchema,
    });
    const { result } = renderHook(() => useAskSql({ transport, answerSchemaQuestions: true }));
    await act(async () => {
      await result.current.ask('how are the tables related?');
    });
    const turn = result.current.turns[0]!;
    expect(explainSchema).toHaveBeenCalledWith('how are the tables related?', undefined);
    expect(turn.phase).toBe('done');
    expect(turn.schemaAnswer?.answer).toContain('customer_id');
    expect(turn.error).toBeUndefined();
  });

  it('does not fall back when answerSchemaQuestions is off', async () => {
    const explainSchema = vi.fn();
    const transport = makeTransport({
      chat: chatOf({ type: 'error', code: 'LLM_BAD_OUTPUT', userMessage: 'nope' }),
      explainSchema,
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    await act(async () => {
      await result.current.ask('how are the tables related?');
    });
    expect(explainSchema).not.toHaveBeenCalled();
    expect(result.current.turns[0]!.phase).toBe('error');
    expect(result.current.turns[0]!.schemaAnswer).toBeUndefined();
  });

  it('ignores empty / whitespace questions', async () => {
    const transport = makeTransport();
    const { result } = renderHook(() => useAskSql({ transport }));
    await act(async () => {
      await result.current.ask('   ');
    });
    expect(result.current.turns).toHaveLength(0);
  });

  it('requireApproval holds at sql_ready until run() is called', async () => {
    const execute = vi.fn(async () => resultOf());
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 2' }, { type: 'done' }), execute });
    const { result } = renderHook(() => useAskSql({ transport, requireApproval: true }));

    await act(async () => {
      await result.current.ask('q');
    });
    expect(result.current.turns[0]!.phase).toBe('sql_ready');
    expect(execute).not.toHaveBeenCalled();

    const id = result.current.turns[0]!.id;
    await act(async () => {
      await result.current.run(id);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.current.turns[0]!.phase).toBe('done');
  });

  it('editSql (auto mode) replaces SQL and re-runs immediately', async () => {
    const execute = vi.fn(async (sql: string) => resultOf({ warnings: [sql] }));
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }), execute });
    const { result } = renderHook(() => useAskSql({ transport }));
    await act(async () => {
      await result.current.ask('q');
    });
    const id = result.current.turns[0]!.id;

    act(() => {
      result.current.editSql(id, 'SELECT 42');
    });
    await waitFor(() => expect(result.current.turns[0]!.phase).toBe('done'));
    expect(result.current.turns[0]!.sql).toBe('SELECT 42');
    expect(execute).toHaveBeenLastCalledWith('SELECT 42', expect.anything());
  });

  it('editSql (approval mode) waits behind the Run button', async () => {
    const execute = vi.fn(async () => resultOf());
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }), execute });
    const { result } = renderHook(() => useAskSql({ transport, requireApproval: true }));
    await act(async () => {
      await result.current.ask('q');
    });
    const id = result.current.turns[0]!.id;
    act(() => {
      result.current.editSql(id, 'SELECT 9');
    });
    expect(result.current.turns[0]!.phase).toBe('sql_ready');
    expect(execute).not.toHaveBeenCalled();
  });

  it('planFor fetches an EXPLAIN plan and stores its text', async () => {
    const execute = vi.fn(async (sql: string) => {
      expect(sql.startsWith('EXPLAIN ')).toBe(true);
      return resultOf({ columns: [{ name: 'p', kind: 'text' }], rows: [['Seq Scan'], ['  Filter: x']], rowCount: 2 });
    });
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }), execute });
    const { result } = renderHook(() => useAskSql({ transport, requireApproval: true }));
    await act(async () => {
      await result.current.ask('q');
    });
    const id = result.current.turns[0]!.id;
    await act(async () => {
      await result.current.planFor(id);
    });
    expect(result.current.turns[0]!.plan).toContain('Seq Scan');
    expect(result.current.turns[0]!.planning).toBe(false);
  });

  it('planFor reports a friendly message when EXPLAIN fails', async () => {
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
      execute: async () => {
        throw { userMessage: 'no plan' };
      },
    });
    const { result } = renderHook(() => useAskSql({ transport, requireApproval: true }));
    await act(async () => {
      await result.current.ask('q');
    });
    const id = result.current.turns[0]!.id;
    await act(async () => {
      await result.current.planFor(id);
    });
    expect(result.current.turns[0]!.plan).toContain('no plan');
  });

  it('planFor is skipped on a connection without EXPLAIN support (no invalid SQL sent)', async () => {
    const execute = vi.fn(async () => resultOf({ rowCount: 0, rows: [] }));
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
      execute,
      connections: [{ id: 'ora', name: 'Ora', engine: 'oracle', capabilities: { supportsExplain: false } }],
    });
    const { result } = renderHook(() => useAskSql({ transport, requireApproval: true }));
    await act(async () => {
      await result.current.ask('q');
    });
    const id = result.current.turns[0]!.id;
    await act(async () => {
      await result.current.planFor(id);
    });
    expect(execute).not.toHaveBeenCalled(); // never ran a bare EXPLAIN against Oracle
    expect(result.current.turns[0]!.plan).toMatch(/not available/i);
    expect(result.current.turns[0]!.planning).toBe(false);
  });

  it('error event in the stream marks the turn retryable', async () => {
    const transport = makeTransport({
      chat: chatOf({ type: 'error', code: 'LLM_UNAVAILABLE', userMessage: 'model down', retryable: true }),
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    await act(async () => {
      await result.current.ask('q');
    });
    const turn = result.current.turns[0]!;
    expect(turn.phase).toBe('error');
    expect(turn.error).toMatchObject({ userMessage: 'model down', retryable: true });
  });

  it('a thrown stream error falls back to a generic error turn', async () => {
    const transport = makeTransport({
      chat: async function* (): AsyncIterable<ChatEvent> {
        throw new Error('boom');
      },
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    await act(async () => {
      await result.current.ask('q');
    });
    expect(result.current.turns[0]!.phase).toBe('error');
    expect(result.current.turns[0]!.error?.code).toBe('LLM_UNAVAILABLE');
  });

  it('a failed run surfaces the error and any suggested fix', async () => {
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELCT 1' }, { type: 'done' }),
      execute: async () => {
        throw { code: 'DB_QUERY_ERROR', userMessage: 'syntax error', retryable: true, suggestedSql: 'SELECT 1' };
      },
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    await act(async () => {
      await result.current.ask('q');
    });
    const turn = result.current.turns[0]!;
    expect(turn.phase).toBe('error');
    expect(turn.error?.retryable).toBe(true);
    expect(turn.suggestedSql).toBe('SELECT 1');
  });

  it('sends only the last few answered turns as follow-up context', async () => {
    const calls: AskParams[] = [];
    let n = 0;
    const transport = makeTransport({
      chat: (params: AskParams) => {
        calls.push(params);
        n += 1;
        return chatOf({ type: 'sql', sql: `SELECT ${n}` }, { type: 'done' })();
      },
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    for (let i = 1; i <= 6; i++) {
      await act(async () => {
        await result.current.ask(`q${i}`);
      });
    }
    // 6th ask carries context from the 5 prior turns, capped at 4 (newest).
    const last = calls[5]!;
    expect(last.context).toHaveLength(4);
    expect(last.context!.map((c) => c.question)).toEqual(['q2', 'q3', 'q4', 'q5']);
  });

  it('cancel aborts the in-flight stream and clears busy', async () => {
    const gate = deferred();
    const transport = makeTransport({
      chat: async function* (): AsyncIterable<ChatEvent> {
        yield { type: 'stage', stage: 'llm' };
        await gate.promise;
      },
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    let asking: Promise<void>;
    act(() => {
      asking = result.current.ask('q');
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    act(() => {
      result.current.cancel();
    });
    expect(result.current.busy).toBe(false);
    gate.resolve();
    await act(async () => {
      await asking;
    });
  });

  it('cancel during streaming leaves a neutral stopped turn, not a red error', async () => {
    const transport = makeTransport({
      chat: async function* (params: AskParams): AsyncIterable<ChatEvent> {
        yield { type: 'stage', stage: 'llm' };
        // Emulate the fetch reader rejecting with AbortError when the user stops.
        await new Promise<void>((_, reject) => {
          params.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      },
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    let asking: Promise<void>;
    act(() => {
      asking = result.current.ask('q');
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await asking;
    });
    const turn = result.current.turns[0]!;
    expect(turn.phase).toBe('stopped');
    expect(turn.error).toBeUndefined();
  });

  it('cancel during a query run leaves a stopped turn, not a red error', async () => {
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
      execute: (_sql, opts) =>
        new Promise((_, reject) => {
          opts!.signal!.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    let asking: Promise<void>;
    act(() => {
      asking = result.current.ask('q');
    });
    await waitFor(() => expect(result.current.turns[0]?.phase).toBe('running'));
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await asking;
    });
    const turn = result.current.turns[0]!;
    expect(turn.phase).toBe('stopped');
    expect(turn.error).toBeUndefined();
  });

  it('does not auto-run a query the user cancelled mid-stream', async () => {
    const execute = vi.fn(async () => resultOf());
    const transport = makeTransport({
      chat: async function* (params: AskParams): AsyncIterable<ChatEvent> {
        yield { type: 'sql', sql: 'SELECT 1' };
        await new Promise<void>((_, reject) => {
          params.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      },
      execute,
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    let asking: Promise<void>;
    act(() => {
      asking = result.current.ask('q');
    });
    await waitFor(() => expect(result.current.turns[0]?.sql).toBe('SELECT 1'));
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await asking;
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.turns[0]!.phase).toBe('stopped');
  });

  it('keeps busy across the auto-run so Stop stays available', async () => {
    const gate = deferred();
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
      execute: async () => {
        await gate.promise;
        return resultOf();
      },
    });
    const { result } = renderHook(() => useAskSql({ transport }));
    let asking: Promise<void>;
    act(() => {
      asking = result.current.ask('q');
    });
    await waitFor(() => expect(result.current.turns[0]?.phase).toBe('running'));
    // Query is executing: busy must stay true (the Stop button is rendered on busy).
    expect(result.current.busy).toBe(true);
    gate.resolve();
    await act(async () => {
      await asking;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.turns[0]!.phase).toBe('done');
  });

  it('reset clears the conversation', async () => {
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }) });
    const { result } = renderHook(() => useAskSql({ transport }));
    await act(async () => {
      await result.current.ask('q');
    });
    expect(result.current.turns).toHaveLength(1);
    act(() => {
      result.current.reset();
    });
    expect(result.current.turns).toHaveLength(0);
  });
});
