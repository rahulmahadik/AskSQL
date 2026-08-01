import { describe, expect, it, vi } from 'vitest';
import { AskSqlServer, ANY_CONNECTION, isStream, type HandlerResponse } from '../src/handler.js';
import type { ChatStreamEvent, ServerRequest } from '../src/types.js';
import type { MongoConnector } from '@asksql/core/mongo';

const CATALOG = {
  engine: 'mongodb',
  schemas: ['shop'],
  tables: [
    {
      name: 'orders',
      schema: 'shop',
      kind: 'table',
      columns: [
        { name: '_id', dbType: 'objectId', nullable: false },
        { name: 'total', dbType: 'number', nullable: true },
      ],
      primaryKey: ['_id'],
      foreignKeys: [],
      indexes: [],
    },
  ],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: '2026-01-01T00:00:00.000Z',
} as never;

function fakeMongo(overrides: Partial<MongoConnector> = {}): MongoConnector {
  return {
    id: 'm1',
    name: 'Shop Mongo',
    engine: 'mongodb',
    database: 'shop',
    connect: async () => {},
    close: async () => {},
    introspect: async () => CATALOG,
    aggregate: vi.fn(async () => ({
      columns: [{ name: 'total', kind: 'number' }],
      rows: [[42]],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
      warnings: [],
    })),
    ...overrides,
  } as MongoConnector;
}

// The Mongo engine expects a mongosh-style aggregate call, not SQL.
const model = async () => '```js\ndb.orders.aggregate([{ "$limit": 5 }])\n```\nCounts orders.';

function server(connector: MongoConnector) {
  return new AskSqlServer({
    connectors: [],
    mongoConnectors: [connector],
    engine: { model },
    auth: () => ({ userId: 'u', allowedConnectionIds: [ANY_CONNECTION] }),
  });
}

const req = (method: string, path: string, body: unknown = {}): ServerRequest => ({
  method,
  path,
  query: {},
  headers: {},
  json: async () => body,
});

async function collect(res: HandlerResponse): Promise<ChatStreamEvent[]> {
  if (!isStream(res)) throw new Error('expected a stream');
  const out: ChatStreamEvent[] = [];
  for await (const e of res.stream) out.push(e);
  return out;
}

describe('MongoDB routing', () => {
  it('does not advertise explain for Mongo - the wire Plan path speaks SQL and would always error', async () => {
    const res = (await server(fakeMongo()).handle(req('GET', '/connections'))) as {
      body: { connections: { capabilities: { supportsExplain: boolean } }[] };
    };
    expect(res.body.connections[0]!.capabilities.supportsExplain).toBe(false);
  });

  it('refuses to delete a connection outside the caller scope, same as querying it', async () => {
    const s = new AskSqlServer({
      connectors: [],
      mongoConnectors: [fakeMongo()],
      engine: { model },
      auth: () => ({ userId: 'u', allowedConnectionIds: ['something-else'] }),
      dynamicConnections: { enabled: true },
    });
    const res = (await s.handle(req('DELETE', '/connections/m1'))) as { status: number };
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('close() on a mongo-only server closes the mongo client instead of throwing', async () => {
    const connector = fakeMongo();
    const closeSpy = vi.spyOn(connector, 'close');
    const s = server(connector);
    await expect(s.close()).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalled();
  });

  // The Mongo engine caches its catalog for 5 minutes, so without an explicit
  // invalidation ?refresh=1 would keep serving the schema from before a new collection.
  it('GET /schema?refresh=1 re-reads a Mongo catalog instead of serving the cached one', async () => {
    let introspects = 0;
    const connector = fakeMongo({
      introspect: async () => {
        introspects++;
        return CATALOG;
      },
    });
    const s = server(connector);
    const schemaReq = (query: Record<string, string>): ServerRequest => ({ ...req('GET', '/schema'), query });

    await s.handle(schemaReq({}));
    await s.handle(schemaReq({}));
    expect(introspects).toBe(1);

    await s.handle(schemaReq({ refresh: '1' }));
    expect(introspects).toBe(2);
  });

  it('reports mongo connections in /health, not just SQL ones', async () => {
    const res = (await server(fakeMongo()).handle(req('GET', '/health'))) as {
      body: { connections: { id: string; engine: string }[] };
    };
    expect(res.body.connections).toEqual([{ id: 'm1', engine: 'mongodb' }]);
  });

  it('forwards follow-up context to the mongo engine instead of silently dropping it', async () => {
    const events = await collect(
      await server(fakeMongo()).handle(
        req('POST', '/chat', {
          question: 'and only shipped ones?',
          context: [{ question: 'how many orders?', sql: '[{ "$limit": 5 }]' }],
        }),
      ),
    );
    expect(events.some((e) => e.type === 'sql')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('lists a Mongo connection alongside SQL ones', async () => {
    const res = (await server(fakeMongo()).handle(req('GET', '/connections'))) as { body: { connections: { id: string; engine: string }[] } };
    expect(res.body.connections).toEqual([
      expect.objectContaining({ id: 'm1', name: 'Shop Mongo', engine: 'mongodb', database: 'shop' }),
    ]);
  });

  it('serves the Mongo catalog on /schema, which the SQL engine could not do', async () => {
    const res = (await server(fakeMongo()).handle(req('GET', '/schema'))) as { status: number; body: { catalog: unknown } };
    expect(res.status).toBe(200);
    expect(res.body.catalog).toEqual(CATALOG);
  });

  it('answers /chat with a pipeline and the collection it runs against', async () => {
    const events = await collect(await server(fakeMongo()).handle(req('POST', '/chat', { question: 'how many orders?' })));
    const sqlEvent = events.find((e) => e.type === 'sql') as { sql: string; collection?: string };

    expect(sqlEvent.collection).toBe('orders');
    expect((sqlEvent as { explanation?: string }).explanation).toContain('Counts orders');
    expect(sqlEvent.sql).toContain('$limit');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('runs a pipeline through the connector when given the collection', async () => {
    const connector = fakeMongo();
    const res = (await server(connector).handle(
      req('POST', '/execute', { sql: '[{ "$limit": 5 }]', collection: 'orders' }),
    )) as { status: number; body: { result: { rows: unknown[][] } } };

    expect(res.status).toBe(200);
    expect(res.body.result.rows).toEqual([[42]]);
    expect(connector.aggregate).toHaveBeenCalledWith('orders', expect.any(Array), expect.any(Object));
  });

  it('refuses to run a pipeline with no collection rather than guessing one', async () => {
    const res = (await server(fakeMongo()).handle(req('POST', '/execute', { sql: '[{ "$limit": 5 }]' }))) as {
      status: number;
      body: { error: { userMessage: string } };
    };
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.userMessage).toMatch(/collection/i);
  });

  it('reports a failing aggregate as a database error instead of crashing the stream', async () => {
    const connector = fakeMongo({
      aggregate: vi.fn(async () => {
        throw new Error('collection not found');
      }) as never,
    });
    const res = (await server(connector).handle(req('POST', '/execute', { sql: '[]', collection: 'orders' }))) as {
      status: number;
      body: { error: { code: string } };
    };
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBeTruthy();
  });
});
