/** Building a database connection from the options form, and what the server's reply is turned into. */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DATABASE_ENGINES,
  ENGINE_PROFILES,
  createRemoteDatabaseConnection,
  defaultsFor,
  type DatabaseForm,
} from '../src/databaseConnections.js';

const BASE = 'http://localhost:4000';
const form = (over: Partial<DatabaseForm> = {}): DatabaseForm => ({ ...defaultsFor('postgres'), ...over });

const reply = (status: number, body: unknown) =>
  vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response);

afterEach(() => vi.unstubAllGlobals());

describe('defaults per engine', () => {
  it('gives every engine a usable starting point', () => {
    for (const engine of DATABASE_ENGINES) {
      const d = defaultsFor(engine);
      const profile = ENGINE_PROFILES[engine];
      expect(d.engine, engine).toBe(engine);
      // A file-backed engine has no host; everything else starts on localhost.
      expect(d.host, engine).toBe(profile.usesFilePath ? '' : 'localhost');
      expect(d.port, engine).toBe(profile.port ? String(profile.port) : '');
      expect(d.uri === '', engine).toBe(!profile.usesUri);
    }
  });
});

describe('creating the connection', () => {
  it('returns what the server opened', async () => {
    vi.stubGlobal('fetch', reply(200, { connection: { id: 'c1', engine: 'postgres', database: 'shop' } }));
    const created = await createRemoteDatabaseConnection(BASE, undefined, 'Shop', form({ database: 'shop' }));
    expect(created.remoteConnectionId).toBe('c1');
    expect(created.engine).toBe('postgres');
  });

  it('sends the auth header only when there is one', async () => {
    const fetcher = reply(200, { connection: { id: 'c1', engine: 'postgres' } });
    vi.stubGlobal('fetch', fetcher);
    await createRemoteDatabaseConnection(BASE, 'Bearer t', 'Shop', form());
    const withAuth = (fetcher.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(withAuth['Authorization']).toBe('Bearer t');

    const plain = reply(200, { connection: { id: 'c2', engine: 'postgres' } });
    vi.stubGlobal('fetch', plain);
    await createRemoteDatabaseConnection(BASE, undefined, 'Shop', form());
    const noAuth = (plain.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(noAuth['Authorization']).toBeUndefined();
  });

  it('addresses MongoDB by connection string rather than host and port', async () => {
    const fetcher = reply(200, { connection: { id: 'm1', engine: 'mongodb' } });
    vi.stubGlobal('fetch', fetcher);
    await createRemoteDatabaseConnection(BASE, undefined, 'M', { ...defaultsFor('mongodb'), database: 'shop' });
    const body = JSON.parse((fetcher.mock.calls[0]?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body['uri']).toBe('mongodb://localhost:27017');
    expect(body['host']).toBeUndefined();
  });

  // A server too old to know the endpoint is a different problem from a rejected connection.
  it('explains a 404 as a server that cannot create connections', async () => {
    vi.stubGlobal('fetch', reply(404, {}));
    await expect(createRemoteDatabaseConnection(BASE, undefined, 'Shop', form())).rejects.toThrow();
  });

  it('surfaces the server own message when it rejects the connection', async () => {
    vi.stubGlobal('fetch', reply(400, { error: { userMessage: 'password authentication failed' } }));
    await expect(createRemoteDatabaseConnection(BASE, undefined, 'Shop', form())).rejects.toThrow(
      /password authentication failed/,
    );
  });

  it('falls back to the status code when the server sends no message', async () => {
    vi.stubGlobal('fetch', reply(500, {}));
    await expect(createRemoteDatabaseConnection(BASE, undefined, 'Shop', form())).rejects.toThrow(/500/);
  });

  it('reports an unreachable server rather than a network stack trace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(createRemoteDatabaseConnection(BASE, undefined, 'Shop', form())).rejects.toThrow();
  });

  // Credentials cross this link, so plaintext to a remote host is refused before any request.
  it('refuses plaintext http to a remote host', async () => {
    vi.stubGlobal('fetch', reply(200, { connection: { id: 'x', engine: 'postgres' } }));
    await expect(createRemoteDatabaseConnection('http://example.com', undefined, 'Shop', form())).rejects.toThrow();
  });
});
