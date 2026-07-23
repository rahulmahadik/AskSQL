/**
 * HttpTransport (sidecar) + LocalTransport (in-browser engine). Covers URL /
 * query building, header merging, JSON unwrapping + typed error mapping, SSE
 * streaming, network-failure mapping, and the engine-backed local adapter.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpTransport, LocalTransport, TransportError } from '../src/client.js';
import type { AskSqlEngine, ResultSet } from '@asksql/core';

const emptyResult: ResultSet = { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0, warnings: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HttpTransport', () => {
  it('lists connections and builds the base URL (trailing slash trimmed)', async () => {
    const fetch = vi.fn(async () => jsonResponse({ connections: [{ id: 'a', name: 'A', engine: 'pg' }] }));
    const t = new HttpTransport({ baseUrl: '/asksql/', fetch });
    const conns = await t.listConnections();
    expect(conns).toEqual([{ id: 'a', name: 'A', engine: 'pg' }]);
    expect(fetch.mock.calls[0]![0]).toBe('/asksql/connections');
  });

  it('merges auth headers and encodes query params', async () => {
    const fetch = vi.fn(async () => jsonResponse({ catalog: { tables: [] } }));
    const t = new HttpTransport({
      baseUrl: 'https://api.example.com/x',
      headers: { Authorization: 'Bearer k' },
      fetch,
    });
    await t.schema('conn 1', true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/x/schema?connectionId=conn%201&refresh=1');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k' });
  });

  it('execute posts JSON and returns the result', async () => {
    const fetch = vi.fn(async () => jsonResponse({ result: emptyResult }));
    const t = new HttpTransport({ baseUrl: '/asksql', fetch });
    const res = await t.execute('SELECT 1', { connectionId: 'c', maxRows: 10 });
    expect(res.rowCount).toBe(0);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ sql: 'SELECT 1', connectionId: 'c', maxRows: 10 });
  });

  it('explain returns the explanation text', async () => {
    const fetch = vi.fn(async () => jsonResponse({ explanation: 'Seq Scan' }));
    const t = new HttpTransport({ baseUrl: '/asksql', fetch });
    expect(await t.explain('SELECT 1', 'c')).toBe('Seq Scan');
  });

  it('maps an error body to a typed TransportError with suggestedSql', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'DB_QUERY_ERROR', userMessage: 'bad sql', retryable: true }, suggestedSql: 'SELECT 1' },
        400,
      ),
    );
    const t = new HttpTransport({ baseUrl: '/asksql', fetch });
    await expect(t.execute('SELCT 1')).rejects.toMatchObject({
      name: 'TransportError',
      code: 'DB_QUERY_ERROR',
      status: 400,
      suggestedSql: 'SELECT 1',
      retryable: true,
    });
  });

  it('falls back to a generic message when the error body is empty', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 500 }));
    const t = new HttpTransport({ baseUrl: '/asksql', fetch });
    await expect(t.explain('SELECT 1')).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 500 });
  });

  it('maps a fetch rejection to a NETWORK_ERROR', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const t = new HttpTransport({ baseUrl: '/asksql', fetch });
    await expect(t.listConnections()).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
  });

  it('rethrows an AbortError untouched', async () => {
    const fetch = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const t = new HttpTransport({ baseUrl: '/asksql', fetch });
    await expect(t.listConnections()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('streams chat as SSE and stops at the done event', async () => {
    const sse =
      'data: {"type":"stage","stage":"llm"}\n\n' +
      'data: {"type":"sql","sql":"SELECT 1"}\n\n' +
      'data: {"type":"done"}\n\n' +
      'data: {"type":"stage","stage":"after"}\n\n';
    const fetch = vi.fn(async () => new Response(sse, { status: 200 }));
    const t = new HttpTransport({ baseUrl: '/asksql', fetch });
    const seen: string[] = [];
    for await (const ev of t.chat({ question: 'q', context: [{ question: 'p', sql: 'SELECT 0' }] })) seen.push(ev.type);
    // Iteration halts at 'done'; the trailing stage after it is never yielded.
    expect(seen).toEqual(['stage', 'sql', 'done']);
  });

  it('chat throws the mapped error when the stream response is not ok', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { code: 'LLM_UNAVAILABLE', userMessage: 'down' } }, 503));
    const t = new HttpTransport({ baseUrl: '/asksql', fetch });
    const iter = t.chat({ question: 'q' });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });
});

describe('TransportError', () => {
  it('carries its code and user message', () => {
    const e = new TransportError('X', 'msg');
    expect(e.message).toBe('msg');
    expect(e.name).toBe('TransportError');
  });
});

describe('LocalTransport', () => {
  function fakeEngine(over: Partial<AskSqlEngine> = {}): AskSqlEngine {
    return {
      connectors: [{ id: 'duck', name: 'Local', engine: 'duckdb', database: 'file.db' }],
      catalog: vi.fn(async () => ({ tables: [] })),
      execute: vi.fn(async () => emptyResult),
      explain: vi.fn(async () => 'plan text'),
      ask: vi.fn(async () => ({ sql: 'SELECT 1', explanation: 'e', guard: { autoLimited: true } })),
      ...over,
    } as unknown as AskSqlEngine;
  }

  it('maps connectors to connection summaries', async () => {
    const t = new LocalTransport(fakeEngine());
    expect(await t.listConnections()).toEqual([{ id: 'duck', name: 'Local', engine: 'duckdb', database: 'file.db' }]);
  });

  it('delegates schema, execute and explain to the engine', async () => {
    const engine = fakeEngine();
    const t = new LocalTransport(engine);
    await t.schema('c', true);
    expect(engine.catalog).toHaveBeenCalledWith('c', { refresh: true });
    await t.execute('SELECT 1');
    expect(engine.execute).toHaveBeenCalled();
    expect(await t.explain('SELECT 1', 'c')).toBe('plan text');
  });

  it('streams engine stage/token events then sql + done', async () => {
    const engine = fakeEngine({
      ask: vi.fn(async (_q: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({ type: 'stage', stage: 'llm' });
        opts.onEvent?.({ type: 'token', text: 'SEL' });
        return { sql: 'SELECT 1', explanation: 'e', guard: { autoLimited: true } };
      }) as unknown as AskSqlEngine['ask'],
    });
    const t = new LocalTransport(engine);
    const events = [];
    for await (const ev of t.chat({ question: 'q' })) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(['stage', 'token', 'sql', 'done']);
    const sql = events.find((e) => e.type === 'sql')!;
    expect(sql).toMatchObject({ sql: 'SELECT 1', autoLimited: true });
  });

  it('emits an error event then done when the engine rejects', async () => {
    const engine = fakeEngine({
      ask: vi.fn(async () => {
        throw { code: 'LLM_UNAVAILABLE', userMessage: 'model down', retryable: true };
      }) as unknown as AskSqlEngine['ask'],
    });
    const t = new LocalTransport(engine);
    const events = [];
    for await (const ev of t.chat({ question: 'q' })) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]).toMatchObject({ code: 'LLM_UNAVAILABLE', userMessage: 'model down' });
  });
});
