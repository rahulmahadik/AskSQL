/**
 * Express adapter tests. Drives asksqlMiddleware with fake req/res objects -
 * no HTTP server, no network. Covers CORS, the application/json CSRF gate,
 * OPTIONS preflight, JSON + SSE responses, and the raw-body size cap.
 */

import { describe, expect, it } from 'vitest';
import { asksqlMiddleware, type ExpressAdapterOptions } from '../src/express.js';
import { POSTGRES_DIALECT, type Connector, type CustomModel, type ResultSet } from '@asksql/core';
import type { AskSqlServerConfig } from '../src/types.js';

class FakeConnector implements Connector {
  engine = 'postgres' as const;
  dialect = POSTGRES_DIALECT;
  capabilities = {
    supportsCancel: true,
    supportsExplain: true,
    supportsSchemas: true,
    readOnlySession: true,
    supportsMatViews: true,
    supportsTriggers: true,
    supportsRoutines: true,
  };
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  async connect() {}
  async close() {}
  async introspect() {
    return {
      engine: 'postgres' as const,
      schemas: ['public'],
      tables: [
        {
          name: 'users',
          kind: 'table' as const,
          columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
          primaryKey: ['id'],
          foreignKeys: [],
          uniques: [],
          checks: [],
          indexes: [],
          source: 'db' as const,
        },
      ],
      enums: [],
      sequences: [],
      triggers: [],
      routines: [],
      warnings: [],
      fetchedAt: 'now',
    };
  }
  async execute(): Promise<ResultSet> {
    return {
      columns: [{ name: 'id', kind: 'bigint' }],
      rows: [['1']],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
      warnings: [],
    };
  }
}

const model: CustomModel = async () => '```sql\nSELECT id FROM users\n```\nAll user ids.';

function config(extra: Partial<AskSqlServerConfig> = {}): AskSqlServerConfig {
  return {
    connectors: [new FakeConnector('db_a', 'DB A')],
    engine: { model },
    auth: () => ({ userId: 'u', allowedConnectionIds: ['db_a'] }),
    ...extra,
  };
}

interface FakeResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  chunks: string[];
}

/** A fake Express response that resolves once end() is called. */
function fakeRes(): { res: never; done: Promise<FakeResult> } {
  let resolve!: (r: FakeResult) => void;
  const done = new Promise<FakeResult>((r) => (resolve = r));
  const state: FakeResult = { statusCode: 0, headers: {}, body: '', chunks: [] };
  const res = {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    setHeader(k: string, v: string) {
      state.headers[k.toLowerCase()] = v;
    },
    write(chunk: string) {
      state.chunks.push(chunk);
    },
    flushHeaders() {},
    end(body?: string) {
      if (body !== undefined) state.body = body;
      resolve(state);
    },
  };
  return { res: res as never, done };
}

interface ReqOpts {
  method: string;
  path?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  chunks?: string[];
}

/** A fake Express request; emits stream chunks after readRawJson subscribes. */
function fakeReq(o: ReqOpts) {
  const handlers: Record<string, (c?: unknown) => void> = {};
  return {
    method: o.method,
    path: o.path,
    url: o.url ?? o.path ?? '/',
    headers: o.headers ?? {},
    query: o.query ?? {},
    body: o.body,
    on(event: string, cb: (c?: unknown) => void) {
      handlers[event] = cb;
      // readRawJson subscribes data, then end, then error - emit once all set.
      if (event === 'error' && o.chunks) {
        setImmediate(() => {
          for (const c of o.chunks!) handlers['data']?.(Buffer.from(c));
          handlers['end']?.();
        });
      }
    },
  };
}

function run(cfg: AskSqlServerConfig, adapter: ExpressAdapterOptions, req: ReqOpts) {
  const mw = asksqlMiddleware(cfg, adapter);
  const { res, done } = fakeRes();
  let nextErr: unknown;
  mw(fakeReq(req) as never, res, (err?: unknown) => (nextErr = err));
  return done.then((r) => ({ ...r, nextErr }));
}

describe('CORS', () => {
  it('reflects the origin without credentials when cors:true', async () => {
    const r = await run(
      config(),
      { cors: true },
      { method: 'OPTIONS', path: '/connections', headers: { origin: 'https://app.example' } },
    );
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('allows a matching allowlist origin with credentials', async () => {
    const r = await run(
      config(),
      { cors: ['https://app.example'] },
      { method: 'OPTIONS', path: '/x', headers: { origin: 'https://app.example' } },
    );
    expect(r.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(r.headers['access-control-allow-credentials']).toBe('true');
  });

  it('emits no CORS header for an origin outside the allowlist', async () => {
    const r = await run(
      config(),
      { cors: ['https://app.example'] },
      { method: 'OPTIONS', path: '/x', headers: { origin: 'https://evil.example' } },
    );
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('supports a wildcard string and a fixed-origin string', async () => {
    const star = await run(
      config(),
      { cors: '*' },
      { method: 'OPTIONS', path: '/x', headers: { origin: 'https://a' } },
    );
    expect(star.headers['access-control-allow-origin']).toBe('*');
    const fixed = await run(
      config(),
      { cors: 'https://app.example' },
      { method: 'OPTIONS', path: '/x', headers: { origin: 'https://app.example' } },
    );
    expect(fixed.headers['access-control-allow-credentials']).toBe('true');
  });

  it('emits no CORS headers when cors is omitted', async () => {
    const r = await run(config(), {}, { method: 'OPTIONS', path: '/x', headers: { origin: 'https://a' } });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CSRF content-type gate', () => {
  it('rejects a POST that is not application/json with 415', async () => {
    const r = await run(
      config(),
      {},
      { method: 'POST', path: '/execute', headers: { 'content-type': 'text/plain' }, body: { sql: 'SELECT 1' } },
    );
    expect(r.statusCode).toBe(415);
    expect(JSON.parse(r.body).error.code).toBe('INVALID_INPUT');
  });

  it('accepts application/json (with charset) and routes to the handler', async () => {
    const r = await run(
      config(),
      {},
      {
        method: 'POST',
        path: '/execute',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: { sql: 'SELECT id FROM users', connectionId: 'db_a' },
      },
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).result.rowCount).toBe(1);
  });
});

describe('JSON responses', () => {
  it('returns a JSON body for GET /connections', async () => {
    const r = await run(config(), {}, { method: 'GET', path: '/connections' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.body).connections[0].id).toBe('db_a');
  });

  it('derives the path from originalUrl/url when req.path is absent', async () => {
    const r = await run(config(), {}, { method: 'GET', url: '/connections?x=1' });
    expect(JSON.parse(r.body).connections[0].id).toBe('db_a');
  });
});

describe('SSE streaming', () => {
  it('streams /chat as text/event-stream ending with a done event', async () => {
    const r = await run(
      config(),
      {},
      {
        method: 'POST',
        path: '/chat',
        headers: { 'content-type': 'application/json' },
        body: { question: 'all ids', connectionId: 'db_a' },
      },
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.headers['x-accel-buffering']).toBe('no');
    const joined = r.chunks.join('');
    expect(joined).toMatch(/data: /);
    expect(joined).toMatch(/"type":"done"/);
  });
});

describe('raw body handling', () => {
  it('parses a JSON body streamed in chunks', async () => {
    const r = await run(
      config(),
      {},
      {
        method: 'POST',
        path: '/execute',
        headers: { 'content-type': 'application/json' },
        chunks: ['{"sql":"SELECT id FROM users",', '"connectionId":"db_a"}'],
      },
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).result.rowCount).toBe(1);
  });

  it('rejects a body that exceeds maxBodyBytes', async () => {
    const r = await run(
      config({ maxBodyBytes: 10 }),
      {},
      {
        method: 'POST',
        path: '/execute',
        headers: { 'content-type': 'application/json' },
        chunks: ['{"sql":"SELECT a very long padded statement here"}'],
      },
    );
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error.userMessage).toMatch(/too large/i);
  });

  it('enforces maxBodyBytes on a pre-parsed body (upstream express.json cannot bypass the cap)', async () => {
    const r = await run(
      config({ maxBodyBytes: 10 }),
      {},
      {
        method: 'POST',
        path: '/execute',
        headers: { 'content-type': 'application/json' },
        // Already parsed by an upstream express.json(): no stream, req.body is set.
        body: { sql: 'SELECT a very long padded statement here', connectionId: 'db_a' },
      },
    );
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error.userMessage).toMatch(/too large/i);
  });

  it('accepts a pre-parsed body within maxBodyBytes', async () => {
    const r = await run(
      config({ maxBodyBytes: 1024 }),
      {},
      {
        method: 'POST',
        path: '/execute',
        headers: { 'content-type': 'application/json' },
        body: { sql: 'SELECT id FROM users', connectionId: 'db_a' },
      },
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).result.rowCount).toBe(1);
  });

  it('treats an empty streamed body as an empty object (400 for missing sql)', async () => {
    const r = await run(
      config(),
      {},
      {
        method: 'POST',
        path: '/execute',
        headers: { 'content-type': 'application/json' },
        chunks: ['   '],
      },
    );
    // Empty body -> {} -> execute rejects missing sql with INVALID_INPUT (400).
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error.code).toBe('INVALID_INPUT');
  });
});
