/**
 * A client hanging up must stop the work, not just the response. The signal was never threaded
 * past the adapters, so Stop aborted the browser fetch while the model call and the database
 * query ran on - billing tokens and holding a connection for nobody.
 */
import { describe, expect, it } from 'vitest';
import { AskSqlServer } from '../src/handler.js';
import type { ServerRequest } from '../src/types.js';
import { POSTGRES_DIALECT } from '@asksql/core';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '@asksql/core';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'orders',
      kind: 'table',
      columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
      primaryKey: ['id'],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
  ],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
};

class FakeConnector implements Connector {
  engine = 'postgres' as const;
  dialect = POSTGRES_DIALECT;
  capabilities = { supportsCancel: true, supportsExplain: true, readOnlySession: true, maxRowsHardCap: 1000 };
  id = 'db';
  name = 'db';
  /** The signal the engine handed down, so the test can assert it is the aborted one. */
  seen: AbortSignal | undefined;
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async introspect(): Promise<SchemaCatalog> {
    return CATALOG;
  }
  async execute(_sql: string, opts?: { signal?: AbortSignal }): Promise<ResultSet> {
    this.seen = opts?.signal;
    return { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 1, warnings: [] };
  }
}

const request = (path: string, body: unknown, signal?: AbortSignal): ServerRequest => ({
  method: 'POST',
  path,
  query: {},
  headers: { 'content-type': 'application/json' },
  json: async () => body,
  ...(signal ? { signal } : {}),
});

function server(connector: Connector, model: CustomModel): AskSqlServer {
  return new AskSqlServer({
    connectors: [connector],
    engine: { model },
    auth: () => ({ userId: 'u', allowedConnectionIds: ['db'] }),
  });
}

describe('a cancelled request cancels the work behind it', () => {
  it('hands the request signal to the connector on /execute', async () => {
    const connector = new FakeConnector();
    const controller = new AbortController();
    const srv = server(connector, async () => 'unused');

    const response = await srv.handle(request('/execute', { connectionId: 'db', sql: 'SELECT id FROM orders' }, controller.signal));

    expect(response.status).toBe(200);
    expect(connector.seen).toBeDefined();
    expect(connector.seen!.aborted).toBe(false);
    controller.abort();
    // Same object, so aborting after the fact is visible - proof it was not a copy or a stub.
    expect(connector.seen!.aborted).toBe(true);
  });

  // Core wraps the caller's signal in a per-attempt controller and detaches the listener when the
  // call ends, so identity is not the thing to assert. Aborting BEFORE the request proves the
  // wiring: the model can only see an already-aborted signal if the request's reached it.
  it('an already-cancelled request reaches the model as cancelled on /chat', async () => {
    const connector = new FakeConnector();
    const controller = new AbortController();
    controller.abort();
    let modelSignal: AbortSignal | undefined;
    const model: CustomModel = async ({ signal }) => {
      modelSignal = signal;
      return '```sql\nSELECT id FROM orders\n```';
    };
    const srv = server(connector, model);

    const response = await srv.handle(request('/chat', { connectionId: 'db', question: 'how many orders' }, controller.signal));
    if ('stream' in response) for await (const ev of response.stream) void ev;

    expect(modelSignal).toBeDefined();
    expect(modelSignal!.aborted).toBe(true);
  });

  it('a live request reaches the model as not cancelled', async () => {
    const connector = new FakeConnector();
    let modelSignal: AbortSignal | undefined;
    const model: CustomModel = async ({ signal }) => {
      modelSignal = signal;
      return '```sql\nSELECT id FROM orders\n```';
    };
    const srv = server(connector, model);

    const response = await srv.handle(
      request('/chat', { connectionId: 'db', question: 'how many orders' }, new AbortController().signal),
    );
    if ('stream' in response) for await (const ev of response.stream) void ev;

    expect(modelSignal!.aborted).toBe(false);
  });

  it('still works when an adapter supplies no signal', async () => {
    const connector = new FakeConnector();
    const srv = server(connector, async () => 'unused');
    const response = await srv.handle(request('/execute', { connectionId: 'db', sql: 'SELECT id FROM orders' }));
    expect(response.status).toBe(200);
  });
});
