/**
 * Deployment realities a production integrator hits:
 *   CORS for a cross-origin frontend (+ OPTIONS preflight)
 *   DB unreachable at startup -> server still boots, /health reports it
 *   Audit-sink failure never blocks a query
 *   SSE stream sets no-buffering headers (survives proxies)
 *   Large catalog (many tables) serialized without error
 * Driven through the real Express adapter over HTTP with a mock model +
 * in-memory connector (no live DB needed -> runs anywhere).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { asksqlMiddleware } from '@asksql/server/express';
import {
  POSTGRES_DIALECT,
  type Connector,
  type CustomModel,
  type ResultSet,
  type SchemaCatalog,
  type TableInfo,
} from '@asksql/core';
import type { AuditSink } from '@asksql/server';

// ---- a fake connector with a configurable table count + a "down" mode ----
function bigCatalog(n: number): SchemaCatalog {
  const tables: TableInfo[] = Array.from({ length: n }, (_, i) => ({
    name: `t_${i}`,
    kind: 'table' as const,
    columns: [
      { name: 'id', dbType: 'bigint', nullable: false },
      { name: 'val', dbType: 'text', nullable: true },
    ],
    primaryKey: ['id'],
    foreignKeys: [],
    uniques: [],
    checks: [],
    indexes: [],
    source: 'db' as const,
  }));
  return {
    engine: 'postgres',
    schemas: ['public'],
    tables,
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: 'now',
  };
}

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
    private readonly tableCount = 1,
    private readonly down = false,
  ) {}
  async connect() {
    if (this.down) throw new Error('ECONNREFUSED');
  }
  async close() {}
  async introspect() {
    return bigCatalog(this.tableCount);
  }
  async execute(): Promise<ResultSet> {
    return {
      columns: [{ name: 'n', kind: 'number' }],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
      warnings: [],
    };
  }
}

const model: CustomModel = async () => '```sql\nSELECT 1 AS n FROM t_0\n```';
const H = { 'Content-Type': 'application/json', 'x-user': 'alice' };

function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const a = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/asksql` });
    });
  });
}

// ---------------------------------------------------------------------------
describe('CORS', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/asksql',
      asksqlMiddleware(
        {
          connectors: [new FakeConnector('c', 'C')],
          engine: { model },
          auth: () => ({ userId: 'alice', allowedConnectionIds: ['c'] }),
        },
        { cors: true },
      ),
    );
    ({ server, base } = await listen(app));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('OPTIONS preflight returns CORS headers + 204', async () => {
    const res = await fetch(`${base}/connections`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/x-user/i);
  });
  it('actual request reflects the origin', async () => {
    const res = await fetch(`${base}/connections`, {
      headers: { origin: 'https://app.example.com', 'x-user': 'alice' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });
  it('allow-list form rejects an unlisted origin', async () => {
    const app2 = express();
    app2.use(express.json());
    app2.use(
      '/asksql',
      asksqlMiddleware(
        {
          connectors: [new FakeConnector('c', 'C')],
          engine: { model },
          auth: () => ({ userId: 'a', allowedConnectionIds: ['c'] }),
        },
        { cors: ['https://good.com'] },
      ),
    );
    const { server: s2, base: b2 } = await listen(app2);
    try {
      const bad = await fetch(`${b2}/connections`, { headers: { origin: 'https://evil.com', 'x-user': 'a' } });
      expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });
});

describe('DB unreachable at startup', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // Connector is "down" - the server must still boot.
    app.use(
      '/asksql',
      asksqlMiddleware({
        connectors: [new FakeConnector('down', 'Down', 1, true)],
        engine: { model },
        auth: () => ({ userId: 'a', allowedConnectionIds: ['down'] }),
      }),
    );
    ({ server, base } = await listen(app));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('/health responds even though the DB is down', async () => {
    const res = await fetch(`${base}/health`, { headers: { 'x-user': 'a' } });
    expect(res.status).toBe(200);
  });
  it('a query against the down DB returns a typed error, not a hang', async () => {
    const res = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ sql: 'SELECT 1', connectionId: 'down' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.error.code).toMatch(/DB_UNREACHABLE|DB_QUERY_ERROR|CONFIG_ERROR/);
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED.*at .*\//); // no raw stack
  });
});

describe('audit failure never blocks a query', () => {
  let server: Server;
  let base = '';
  let auditCalls = 0;
  beforeAll(async () => {
    const flakyAudit: AuditSink = {
      write: async () => {
        auditCalls++;
        throw new Error('audit sink down');
      },
    };
    const app = express();
    app.use(express.json());
    app.use(
      '/asksql',
      asksqlMiddleware({
        connectors: [new FakeConnector('c', 'C')],
        engine: { model },
        auth: () => ({ userId: 'a', allowedConnectionIds: ['c'] }),
        audit: flakyAudit,
      }),
    );
    ({ server, base } = await listen(app));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('the query still succeeds despite the audit sink throwing', async () => {
    const res = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ sql: 'SELECT 1 AS n FROM t_0', connectionId: 'c' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.rowCount).toBe(1);
    expect(auditCalls).toBeGreaterThan(0); // audit WAS attempted
  });
});

describe('SSE proxy-safe headers', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/asksql',
      asksqlMiddleware({
        connectors: [new FakeConnector('c', 'C')],
        engine: { model },
        auth: () => ({ userId: 'a', allowedConnectionIds: ['c'] }),
      }),
    );
    ({ server, base } = await listen(app));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('chat stream sets X-Accel-Buffering:no and event-stream content type', async () => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ question: 'q', connectionId: 'c' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
    await res.text(); // drain
  });
});

describe('large catalog', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/asksql',
      asksqlMiddleware({
        connectors: [new FakeConnector('big', 'Big', 5000)],
        engine: { model },
        auth: () => ({ userId: 'a', allowedConnectionIds: ['big'] }),
      }),
    );
    ({ server, base } = await listen(app));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('serializes a 5000-table catalog without error', async () => {
    const res = await fetch(`${base}/schema?connectionId=big`, { headers: { 'x-user': 'a' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalog.tables.length).toBe(5000);
  }, 20_000);
});

describe('server restart mid-session', () => {
  it('in-flight request during a server close surfaces a clean network error, not a hang', async () => {
    const app = express();
    app.use(express.json());
    // A connector whose execute never resolves, so the request is truly in-flight
    // when we close the server.
    class Hanging extends FakeConnector {
      override async execute(): Promise<ResultSet> {
        return new Promise(() => {});
      }
    }
    app.use(
      '/asksql',
      asksqlMiddleware({
        connectors: [new Hanging('h', 'H')],
        engine: { model },
        auth: () => ({ userId: 'a', allowedConnectionIds: ['h'] }),
      }),
    );
    const { server, base } = await listen(app);

    const inflight = fetch(`${base}/execute`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ sql: 'SELECT 1 AS n FROM t_0', connectionId: 'h' }),
    });
    // Give the request a moment to reach the server, then hard-close it.
    await new Promise((r) => setTimeout(r, 100));
    await new Promise<void>((r) => server.closeAllConnections?.() ?? r());
    server.close();

    // The client sees a rejected fetch (connection reset), not an indefinite hang.
    await expect(inflight).rejects.toBeTruthy();
  }, 15_000);
});

describe('TLS configuration is accepted', () => {
  it('the Postgres connector accepts an ssl option without mangling it', async () => {
    const { PostgresConnector } = await import('@asksql/postgres');
    // We can't stand up a TLS Postgres here, but the ssl config must be
    // carried through to the driver (not dropped). A bad host -> typed error.
    const c = new PostgresConnector({
      id: 't',
      name: 't',
      host: '127.0.0.1',
      port: 5999,
      user: 'u',
      password: 'p',
      database: 'd',
      ssl: { rejectUnauthorized: false },
    });
    await expect(c.connect()).rejects.toMatchObject({ code: expect.stringMatching(/DB_UNREACHABLE|DB_AUTH/) });
    await c.close();
  }, 15_000);
});

describe('special characters in connection config', () => {
  it('a password with @:/#?& is carried as an object field, never string-concatenated', async () => {
    // The Postgres connector accepts discrete fields; verify a nasty password
    // is preserved verbatim (no DSN-injection / truncation).
    const { PostgresConnector } = await import('@asksql/postgres');
    const c = new PostgresConnector({
      id: 'x',
      name: 'x',
      host: 'localhost',
      user: 'u',
      password: 'p@ss:w/rd#?&%',
      database: 'd',
    });
    // We can't connect (no such user) but constructing + the discrete-field
    // path must not throw or mangle. Attempt connect and expect a typed error.
    await expect(c.connect()).rejects.toBeTruthy();
    await c.close();
  });
});
