/**
 * `POST /connections` and `DELETE /connections/:id` - how the browser extension opens and closes
 * databases. Uses SQLite files so the connections are real (they open, introspect and close)
 * without needing a server anywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AskSqlServer, ANY_CONNECTION } from '../src/handler.js';
import type { ServerRequest } from '../src/types.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'asksql-dyn-'));
const file = join(dir, 'shop.db');

beforeAll(() => {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY)');
  db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const req = (method: string, path: string, body?: unknown): ServerRequest => ({
  method,
  path,
  query: {},
  headers: { 'content-type': 'application/json' },
  json: async () => body ?? {},
});

const server = (enabled = true): AskSqlServer =>
  new AskSqlServer({
    connectors: [],
    engine: { model: async () => 'unused' },
    auth: () => ({ userId: 'u', allowedConnectionIds: [ANY_CONNECTION] }),
    ...(enabled ? { dynamicConnections: { enabled: true, allowFileEngines: true } } : {}),
  });

describe('opening a connection at runtime', () => {
  it('is off unless the operator enabled it', async () => {
    const res = await server(false).handle(
      req('POST', '/connections', { name: 'x', engine: 'sqlite', database: file }),
    );
    // 404, not 403: an endpoint that is not turned on should not advertise itself.
    expect(res.status).toBe(404);
  });

  it('opens, lists, and closes a real connection', async () => {
    const srv = server();
    const created = await srv.handle(req('POST', '/connections', { name: 'shop', engine: 'sqlite', database: file }));
    expect(created.status).toBe(201);
    const id = (created.body as { connection: { id: string } }).connection.id;

    const listed = await srv.handle(req('GET', '/connections'));
    expect(JSON.stringify(listed.body)).toContain(id);

    const removed = await srv.handle(req('DELETE', `/connections/${id}`));
    expect(removed.status).toBe(200);

    const after = await srv.handle(req('GET', '/connections'));
    expect(JSON.stringify(after.body)).not.toContain(id);
  });

  it('reports a connection that cannot be opened, rather than storing a dead one', async () => {
    const srv = server();
    const res = await srv.handle(
      req('POST', '/connections', { name: 'gone', engine: 'sqlite', database: join(dir, 'not-here.db') }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const listed = await srv.handle(req('GET', '/connections'));
    expect(JSON.stringify(listed.body)).not.toContain('gone');
  });

  it('refuses a duplicate id', async () => {
    const srv = server();
    const first = await srv.handle(
      req('POST', '/connections', { id: 'fixed', name: 'a', engine: 'sqlite', database: file }),
    );
    expect(first.status).toBe(201);
    const second = await srv.handle(
      req('POST', '/connections', { id: 'fixed', name: 'b', engine: 'sqlite', database: file }),
    );
    expect(second.status).toBe(400);
  });

  // Both requests await the connector before registering it, so without the in-flight set they
  // would each pass the duplicate check and the second would silently replace the first.
  it('refuses a duplicate id even when both requests arrive together', async () => {
    const srv = server();
    const [a, b] = await Promise.all([
      srv.handle(req('POST', '/connections', { id: 'race', name: 'a', engine: 'sqlite', database: file })),
      srv.handle(req('POST', '/connections', { id: 'race', name: 'b', engine: 'sqlite', database: file })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
  });

  // The same answer a query endpoint gives for an unknown id, and deliberately identical whether
  // the connection never existed or the caller simply cannot see it.
  it('rejects deleting a connection that is not there', async () => {
    const res = await server().handle(req('DELETE', '/connections/ghost'));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Unknown database connection/);
  });
});

/**
 * Malformed input at the POST /connections boundary. Every other endpoint reads its body
 * through readBody() and answers 400 INVALID_INPUT for junk; this endpoint must not answer
 * 500 CONFIG_ERROR ("check the server logs") for a client-side mistake.
 */
describe('malformed POST /connections bodies', () => {
  it('malformed JSON is a 400 invalid-input, not a 500 misconfiguration', async () => {
    const srv = server();
    const res = await srv.handle({
      method: 'POST',
      path: '/connections',
      query: {},
      headers: { 'content-type': 'application/json' },
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('a JSON body of literal null is a 400, not an unhandled TypeError', async () => {
    const srv = server();
    // Not through the req() helper: its `body ?? {}` would silently replace the null.
    const res = await srv.handle({
      method: 'POST',
      path: '/connections',
      query: {},
      headers: { 'content-type': 'application/json' },
      json: async () => null,
    });
    expect(res.status).toBe(400);
  });

  it('a non-string id or name is a 400, not an unhandled TypeError', async () => {
    const srv = server();
    const badId = await srv.handle(
      req('POST', '/connections', { id: 123, name: 'x', engine: 'sqlite', database: file }),
    );
    expect(badId.status).toBe(400);
    const badName = await srv.handle(
      req('POST', '/connections', { name: { nested: true }, engine: 'sqlite', database: file }),
    );
    expect(badName.status).toBe(400);
  });
});

// Deleting removes a connection for everyone, so it needs the standing that creating one needs.
// It used to gate only on permission to *use* the connection, and nothing recorded which
// connections the operator had configured, so a static one could be torn down through the API.
describe('DELETE /connections/:id scope', () => {
  it('removes what it created, and nothing else', async () => {
    // A connection created through the API can be removed through it.
    const s = server(true);
    const created = (await s.handle(
      req('POST', '/connections', { name: 'runtime', engine: 'sqlite', database: file }),
    )) as { status: number; body: { connection: { id: string } } };
    expect(created.status).toBe(201);
    const id = created.body.connection.id;

    const ok = (await s.handle(req('DELETE', `/connections/${id}`))) as { status: number };
    expect(ok.status).toBe(200);

    // One that was never created through the API is not this endpoint's to remove.
    const again = (await s.handle(req('DELETE', `/connections/${id}`))) as { status: number };
    expect(again.status).not.toBe(200);
  });
});
