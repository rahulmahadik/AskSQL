/**
 * Server sidecar tests. Drives AskSqlServer.handle
 * directly with a fake connector + mock model - no HTTP, no network.
 */
import { describe, expect, it } from 'vitest';
import { AskSqlServer, isStream, type ChatStreamEvent } from '../src/index.js';
import { AskSqlError, POSTGRES_DIALECT, type Connector, type CustomModel, type ResultSet, type ServerRequest as _sr } from '@asksql/core';
import type { ServerRequest } from '../src/types.js';

class FakeConnector implements Connector {
  engine = 'postgres' as const;
  dialect = POSTGRES_DIALECT;
  capabilities = { supportsCancel: true, supportsExplain: true, supportsSchemas: true, readOnlySession: true, supportsMatViews: true, supportsTriggers: true, supportsRoutines: true };
  constructor(readonly id: string, readonly name: string, private readonly secret: string) {}
  async connect() {}
  async close() {}
  async introspect() {
    return {
      engine: 'postgres' as const, schemas: ['public'],
      tables: [{ name: 'users', kind: 'table' as const, columns: [{ name: 'id', dbType: 'bigint', nullable: false }, { name: 'name', dbType: 'text', nullable: true }], primaryKey: ['id'], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db' as const }],
      enums: [], sequences: [], triggers: [], routines: [], warnings: [], fetchedAt: 'now',
    };
  }
  async execute(sql: string): Promise<ResultSet> {
    // The secret is embedded in the connector but must NEVER surface.
    void this.secret;
    return { columns: [{ name: 'id', kind: 'bigint' }], rows: [['1']], rowCount: 1, truncated: false, durationMs: 1, warnings: [] };
  }
}

const model: CustomModel = async () => '```sql\nSELECT id FROM users\n```\nAll user ids.';

function makeServer(auth: (req: ServerRequest) => unknown) {
  return new AskSqlServer({
    connectors: [
      new FakeConnector('db_a', 'DB A', 'password=SUPERSECRET_A'),
      new FakeConnector('db_b', 'DB B', 'password=SUPERSECRET_B'),
    ],
    engine: { model },
    auth: auth as never,
  });
}

const req = (method: string, path: string, body?: unknown, query: Record<string, string> = {}): ServerRequest => ({
  method,
  path,
  query,
  headers: {},
  json: async () => body ?? {},
});

const allowAll = () => ({ userId: 'u1', allowedConnectionIds: ['db_a', 'db_b'] });
const allowA = () => ({ userId: 'u2', allowedConnectionIds: ['db_a'] });

describe('auth', () => {
  it('auth returning null -> 403, no fail-open', async () => {
    const s = makeServer(() => null);
    const r = await s.handle(req('GET', '/connections'));
    expect(isStream(r)).toBe(false);
    if (!isStream(r)) expect(r.status).toBe(403);
  });
  it('auth throwing -> 403', async () => {
    const s = makeServer(() => { throw new Error('boom'); });
    const r = await s.handle(req('GET', '/connections'));
    if (!isStream(r)) expect(r.status).toBe(403);
  });
});

describe('/ connection scope', () => {
  it('user sees only allowed connections', async () => {
    const s = makeServer(allowA);
    const r = await s.handle(req('GET', '/connections'));
    if (!isStream(r)) {
      const conns = (r.body as { connections: { id: string }[] }).connections;
      expect(conns.map((c) => c.id)).toEqual(['db_a']);
    }
  });
  it('accessing another user\'s connection -> 403', async () => {
    const s = makeServer(allowA);
    const r = await s.handle(req('POST', '/execute', { sql: 'SELECT id FROM users', connectionId: 'db_b' }));
    if (!isStream(r)) expect(r.status).toBe(403);
  });
});

describe('/history is per-user', () => {
  const byUser = (r: ServerRequest) => ({
    userId: r.headers['x-user'] === 'bob' ? 'bob' : 'alice',
    allowedConnectionIds: ['db_a'],
  });
  const withUser = (u: string, m: string, p: string, b?: unknown, q: Record<string, string> = {}): ServerRequest => ({
    ...req(m, p, b, q),
    headers: { 'x-user': u },
  });

  it("one user cannot read another user's history on a shared connection", async () => {
    const s = makeServer(byUser);
    // Alice runs a query -> a history row is recorded as alice.
    await s.handle(withUser('alice', 'POST', '/execute', { sql: 'SELECT id FROM users', connectionId: 'db_a' }));

    const aliceHist = await s.handle(withUser('alice', 'GET', '/history', undefined, { connectionId: 'db_a' }));
    const bobHist = await s.handle(withUser('bob', 'GET', '/history', undefined, { connectionId: 'db_a' }));
    if (!isStream(aliceHist) && !isStream(bobHist)) {
      expect((aliceHist.body as { total: number }).total).toBe(1);
      expect((bobHist.body as { total: number }).total).toBe(0);
      expect((bobHist.body as { items: unknown[] }).items).toEqual([]);
    }
  });
});

describe('credential leak sweep', () => {
  it('no response body contains a connector secret', async () => {
    const s = makeServer(allowAll);
    const responses = await Promise.all([
      s.handle(req('GET', '/connections')),
      s.handle(req('GET', '/schema', undefined, { connectionId: 'db_a' })),
      s.handle(req('GET', '/health')),
      s.handle(req('POST', '/execute', { sql: 'SELECT id FROM users', connectionId: 'db_a' })),
      s.handle(req('POST', '/execute', { sql: 'DROP TABLE users', connectionId: 'db_a' })),
    ]);
    for (const r of responses) {
      if (!isStream(r)) {
        const text = JSON.stringify(r.body);
        expect(text).not.toMatch(/SUPERSECRET/);
        expect(text).not.toMatch(/password=/);
      }
    }
  });
});

describe('server-side guard', () => {
  it('blocks a write POSTed directly to /execute', async () => {
    const s = makeServer(allowAll);
    const r = await s.handle(req('POST', '/execute', { sql: 'DELETE FROM users', connectionId: 'db_a' }));
    if (!isStream(r)) {
      expect(r.status).toBe(400);
      expect((r.body as { error: { code: string } }).error.code).toBe('GUARD_BLOCKED');
    }
  });
  it('runs a legit SELECT', async () => {
    const s = makeServer(allowAll);
    const r = await s.handle(req('POST', '/execute', { sql: 'SELECT id FROM users', connectionId: 'db_a' }));
    if (!isStream(r)) {
      expect(r.status).toBe(200);
      expect((r.body as { result: { rowCount: number } }).result.rowCount).toBe(1);
    }
  });
});

describe('GET /schema + /history pagination', () => {
  it('returns a catalog', async () => {
    const s = makeServer(allowAll);
    const r = await s.handle(req('GET', '/schema', undefined, { connectionId: 'db_a' }));
    if (!isStream(r)) {
      const cat = (r.body as { catalog: { tables: unknown[] } }).catalog;
      expect(cat.tables).toHaveLength(1);
    }
  });
  it('history has total/page/per_page', async () => {
    const s = makeServer(allowAll);
    await s.handle(req('POST', '/execute', { sql: 'SELECT id FROM users', connectionId: 'db_a' }));
    const r = await s.handle(req('GET', '/history', undefined, { connectionId: 'db_a' }));
    if (!isStream(r)) {
      const body = r.body as { total: number; page: number; per_page: number };
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.page).toBe(1);
      expect(body.per_page).toBe(50);
    }
  });
});

describe('POST /chat SSE stream', () => {
  it('streams stage events then a sql event then done', async () => {
    const s = makeServer(allowAll);
    const r = await s.handle(req('POST', '/chat', { question: 'all user ids', connectionId: 'db_a' }));
    expect(isStream(r)).toBe(true);
    if (isStream(r)) {
      const events: ChatStreamEvent[] = [];
      for await (const e of r.stream) events.push(e);
      const types = events.map((e) => e.type);
      expect(types).toContain('stage');
      expect(types).toContain('sql');
      expect(types[types.length - 1]).toBe('done');
      const sqlEvent = events.find((e) => e.type === 'sql') as Extract<ChatStreamEvent, { type: 'sql' }>;
      expect(sqlEvent.sql).toMatch(/SELECT id FROM users/i);
    }
  });
});

describe('ERR unknown endpoint', () => {
  it('404 for unknown path', async () => {
    const s = makeServer(allowAll);
    const r = await s.handle(req('GET', '/nope'));
    if (!isStream(r)) expect(r.status).toBe(404);
  });
});

describe('suggested fix on DB error', () => {
  // A connector that rejects the "bad" query but introspects normally, so the
  // /execute path fails with a DB error and the server can offer a repair.
  class FailingConnector extends FakeConnector {
    override async execute(sql: string): Promise<ResultSet> {
      if (/bogus/i.test(sql)) throw new Error('Unknown column "bogus" in field list');
      return { columns: [{ name: 'id', kind: 'bigint' }], rows: [['1']], rowCount: 1, truncated: false, durationMs: 1, warnings: [] };
    }
  }
  const fixModel: CustomModel = async () => '```sql\nSELECT id, name FROM users\n```\ncorrected';

  it('returns a corrected query as suggestedSql (default on)', async () => {
    const s = new AskSqlServer({ connectors: [new FailingConnector('db', 'DB', 's')], engine: { model: fixModel }, auth: (() => ({ userId: 'u', allowedConnectionIds: ['db'] })) as never });
    const r = await s.handle(req('POST', '/execute', { sql: 'SELECT bogus FROM users', connectionId: 'db', question: 'list users' }));
    if (isStream(r)) throw new Error('unexpected stream');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((r.body as { error: { code: string } }).error.code).toBe('DB_QUERY_ERROR');
    expect((r.body as { suggestedSql?: string }).suggestedSql).toMatch(/SELECT id, name FROM users/i);
  });

  it('omits the suggestion when suggestFixOnError is false', async () => {
    const s = new AskSqlServer({ connectors: [new FailingConnector('db', 'DB', 's')], engine: { model: fixModel }, auth: (() => ({ userId: 'u', allowedConnectionIds: ['db'] })) as never, suggestFixOnError: false });
    const r = await s.handle(req('POST', '/execute', { sql: 'SELECT bogus FROM users', connectionId: 'db', question: 'list users' }));
    if (isStream(r)) throw new Error('unexpected stream');
    expect((r.body as { suggestedSql?: string }).suggestedSql).toBeUndefined();
  });

  it('no suggestion without the original question', async () => {
    const s = new AskSqlServer({ connectors: [new FailingConnector('db', 'DB', 's')], engine: { model: fixModel }, auth: (() => ({ userId: 'u', allowedConnectionIds: ['db'] })) as never });
    const r = await s.handle(req('POST', '/execute', { sql: 'SELECT bogus FROM users', connectionId: 'db' }));
    if (isStream(r)) throw new Error('unexpected stream');
    expect((r.body as { suggestedSql?: string }).suggestedSql).toBeUndefined();
  });
});

describe('chat stream surfaces an early ask failure (no hang)', () => {
  // A connector whose introspect throws makes engine.ask() fail BEFORE any
  // stage events - the case that previously hung the SSE stream forever
  // (wake; instead of wake()). The stream must emit an error event and finish.
  class BrokenIntrospect extends FakeConnector {
    override async introspect(): Promise<never> {
      throw new AskSqlError('DB_UNREACHABLE', { userMessage: "Can't reach the database right now." });
    }
  }
  it('emits an error event and done, does not hang', async () => {
    const s = new AskSqlServer({ connectors: [new BrokenIntrospect('db', 'DB', 's')], engine: { model }, auth: (() => ({ userId: 'u', allowedConnectionIds: ['db'] })) as never });
    const r = await s.handle(req('POST', '/chat', { question: 'how many users', connectionId: 'db' }));
    if (!isStream(r)) throw new Error('expected a stream');
    const events: ChatStreamEvent[] = [];
    // If the stream hangs, the surrounding vitest timeout fails the test.
    for await (const e of r.stream) events.push(e);
    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('done');
    const errEvent = events.find((e) => e.type === 'error') as Extract<ChatStreamEvent, { type: 'error' }>;
    expect(errEvent.code).toBe('DB_UNREACHABLE');
    expect(errEvent.retryable).toBe(true);
  }, 10_000);
});
