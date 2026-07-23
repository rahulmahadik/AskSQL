/**
 * Handler branches not covered by handler.test.ts: config/auth guards, the
 * /explain route, the audit sink, the onError hook, connection resolution
 * defaults, and the error -> HTTP status mapping.
 */

import { describe, expect, it } from 'vitest';
import { AskSqlServer, errorResponse, isStream } from '../src/index.js';
import { AskSqlError, POSTGRES_DIALECT, type Connector, type CustomModel, type ResultSet } from '@asksql/core';
import type { AskSqlServerConfig, AuditRecord, ServerRequest } from '../src/types.js';

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

function makeServer(extra: Partial<AskSqlServerConfig> = {}) {
  return new AskSqlServer({
    connectors: [new FakeConnector('db_a', 'DB A')],
    engine: { model },
    auth: () => ({ userId: 'u', allowedConnectionIds: ['db_a'] }),
    ...extra,
  });
}

const req = (method: string, path: string, body?: unknown, query: Record<string, string> = {}): ServerRequest => ({
  method,
  path,
  query,
  headers: {},
  json: async () => body ?? {},
});

async function statusOf(r: Awaited<ReturnType<AskSqlServer['handle']>>): Promise<number> {
  if (isStream(r)) throw new Error('unexpected stream');
  return r.status;
}

describe('config + auth guards', () => {
  it('throws CONFIG_ERROR when no auth hook is provided', () => {
    expect(
      () =>
        new AskSqlServer({
          connectors: [new FakeConnector('db_a', 'DB A')],
          engine: { model },
        } as unknown as AskSqlServerConfig),
    ).toThrow(/auth/i);
  });

  it('denies when the auth hook returns a context without an allowed-ids array', async () => {
    const s = makeServer({ auth: (() => ({ userId: 'u' })) as never });
    expect(await statusOf(await s.handle(req('GET', '/connections')))).toBe(403);
  });
});

describe('/explain', () => {
  it('returns a plain-language explanation', async () => {
    const s = makeServer();
    const r = await s.handle(req('POST', '/explain', { sql: 'SELECT id FROM users', connectionId: 'db_a' }));
    if (isStream(r)) throw new Error('unexpected stream');
    expect(r.status).toBe(200);
    expect(typeof (r.body as { explanation: string }).explanation).toBe('string');
  });
});

describe('connection resolution', () => {
  it('defaults to the first allowed connection when none is supplied', async () => {
    const s = makeServer();
    const r = await s.handle(req('GET', '/schema'));
    expect(await statusOf(r)).toBe(200);
  });

  it('rejects an unknown connection id with 400 INVALID_INPUT', async () => {
    const s = makeServer({ auth: (() => ({ userId: 'u', allowedConnectionIds: ['db_a', 'ghost'] })) as never });
    const r = await s.handle(req('GET', '/schema', undefined, { connectionId: 'ghost' }));
    if (isStream(r)) throw new Error('unexpected stream');
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('denies when the caller has no connections at all', async () => {
    const s = makeServer({ auth: (() => ({ userId: 'u', allowedConnectionIds: [] })) as never });
    expect(await statusOf(await s.handle(req('GET', '/schema')))).toBe(403);
  });
});

describe('audit sink', () => {
  it('records an allowed execute and swallows a sink failure', async () => {
    const records: AuditRecord[] = [];
    const s = makeServer({ audit: { write: async (r) => void records.push(r) } });
    await s.handle(req('POST', '/execute', { sql: 'SELECT id FROM users', connectionId: 'db_a' }));
    expect(records).toHaveLength(1);
    expect(records[0]!.guardVerdict).toBe('allowed');
    expect(records[0]!.rowCount).toBe(1);

    const throwing = makeServer({
      audit: {
        write: async () => {
          throw new Error('sink down');
        },
      },
    });
    const r = await throwing.handle(req('POST', '/execute', { sql: 'SELECT id FROM users', connectionId: 'db_a' }));
    // The query still succeeds despite the audit write throwing.
    expect(await statusOf(r)).toBe(200);
  });

  it('records a blocked verdict when the guard rejects a write', async () => {
    const records: AuditRecord[] = [];
    const s = makeServer({ audit: { write: async (r) => void records.push(r) } });
    await s.handle(req('POST', '/execute', { sql: 'DELETE FROM users', connectionId: 'db_a' }));
    expect(records[0]!.guardVerdict).toBe('blocked');
    expect(records[0]!.status).toBe('blocked');
  });
});

describe('onError hook', () => {
  it('is called for an error response and a throwing hook is swallowed', async () => {
    const seen: string[] = [];
    const s = makeServer({
      onError: (_err, ctx) => {
        seen.push(ctx.path);
        throw new Error('hook boom');
      },
    });
    // A guard-blocked write produces an error response, invoking onError.
    const r = await s.handle(req('POST', '/execute', { sql: 'DELETE FROM users', connectionId: 'db_a' }));
    expect(await statusOf(r)).toBe(400);
    expect(seen).toContain('/execute');
  });

  it('swallows a rejected async onError hook', async () => {
    const s = makeServer({ onError: () => Promise.reject(new Error('async boom')) });
    const r = await s.handle(req('POST', '/execute', { sql: 'DELETE FROM users', connectionId: 'db_a' }));
    expect(await statusOf(r)).toBe(400);
  });
});

describe('readBody', () => {
  it('maps invalid JSON to 400 INVALID_INPUT', async () => {
    const s = makeServer();
    const bad: ServerRequest = {
      method: 'POST',
      path: '/execute',
      query: {},
      headers: {},
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    };
    const r = await s.handle(bad);
    if (isStream(r)) throw new Error('unexpected stream');
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('rethrows an AskSqlError from the body reader unchanged (e.g. body too large)', async () => {
    const s = makeServer();
    const tooBig: ServerRequest = {
      method: 'POST',
      path: '/execute',
      query: {},
      headers: {},
      json: async () => {
        throw new AskSqlError('INVALID_INPUT', { userMessage: 'The request body is too large.' });
      },
    };
    const r = await s.handle(tooBig);
    if (isStream(r)) throw new Error('unexpected stream');
    expect((r.body as { error: { userMessage: string } }).error.userMessage).toMatch(/too large/i);
  });
});

describe('errorResponse status mapping', () => {
  const cases: [string, number][] = [
    ['SERVER_AUTHZ', 403],
    ['INVALID_INPUT', 400],
    ['GUARD_BLOCKED', 400],
    ['DB_AUTH', 500],
    ['CONFIG_ERROR', 500],
    ['DB_UNREACHABLE', 502],
    ['LLM_UNREACHABLE', 502],
    ['DB_TIMEOUT', 504],
    ['LLM_TIMEOUT', 504],
    ['LLM_RATE_LIMIT', 429],
    ['LLM_BILLING', 402],
    ['LLM_UNAVAILABLE', 400], // unmapped -> falls through to 400
  ];
  it('maps each error code to the documented HTTP status', () => {
    for (const [code, status] of cases) {
      const r = errorResponse(new AskSqlError(code as never, { userMessage: 'x' }));
      expect([code, r.status]).toEqual([code, status]);
      // Only code/userMessage/retryable reach the wire - never detail.
      expect(r.body).toHaveProperty('error');
      expect(JSON.stringify(r.body)).not.toMatch(/detail/);
    }
  });

  it('passes a suggestedSql through onto the response body', () => {
    const e = Object.assign(new AskSqlError('DB_QUERY_ERROR', { userMessage: 'x' }), { suggestedSql: 'SELECT 1' });
    const r = errorResponse(e);
    expect((r.body as { suggestedSql?: string }).suggestedSql).toBe('SELECT 1');
  });
});
