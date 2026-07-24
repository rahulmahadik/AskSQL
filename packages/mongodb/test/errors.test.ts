/**
 * Error mapping with the mongodb driver mocked - no server needed. Covers
 * connect-time auth/unreachable classification and aggregate-time timeout
 * mapping.
 */

import { describe, expect, it, vi } from 'vitest';
import { MongodbConnector } from '../src/index.js';

interface Behavior {
  connect?: () => Promise<void>;
  ping?: () => Promise<unknown>;
  hasNext?: () => Promise<boolean>;
}

const state = vi.hoisted(() => ({ behavior: {} as Behavior }));

vi.mock('mongodb', () => {
  class MongoClient {
    async connect(): Promise<MongoClient> {
      await state.behavior.connect?.();
      return this;
    }
    async close(): Promise<void> {}
    db(): unknown {
      return {
        command: () => (state.behavior.ping ? state.behavior.ping() : Promise.resolve({ ok: 1 })),
        listCollections: () => ({ toArray: async () => [] }),
        collection: () => ({
          aggregate: () => ({
            hasNext: () => (state.behavior.hasNext ? state.behavior.hasNext() : Promise.resolve(false)),
            next: async () => null,
            toArray: async () => [],
            close: async () => {},
          }),
          estimatedDocumentCount: async () => 0,
        }),
      };
    }
  }
  return { MongoClient, EJSON: { deserialize: (v: unknown) => v } };
});

function connector(): MongodbConnector {
  return new MongodbConnector({ id: 'm', name: 'm', connectionString: 'mongodb://db.example/', database: 'appdb' });
}

describe('connect error mapping', () => {
  it('maps code 18 (AuthenticationFailed) to DB_AUTH', async () => {
    state.behavior = {
      connect: () => Promise.reject(Object.assign(new Error('Authentication failed.'), { code: 18 })),
    };
    await expect(connector().connect()).rejects.toMatchObject({ name: 'AskSqlError', code: 'DB_AUTH' });
  });

  it('maps a failed ping to DB_UNREACHABLE', async () => {
    state.behavior = { ping: () => Promise.reject(new Error('getaddrinfo ENOTFOUND db.example')) };
    await expect(connector().connect()).rejects.toMatchObject({ code: 'DB_UNREACHABLE' });
  });

  it('an auth failure explains the credentials and the < > placeholder gotcha', async () => {
    state.behavior = { connect: () => Promise.reject(Object.assign(new Error('bad auth'), { code: 18 })) };
    await expect(connector().connect()).rejects.toMatchObject({
      code: 'DB_AUTH',
      userMessage: expect.stringMatching(/angle brackets|username and password/i),
    });
  });

  it('an Atlas (srv / *.mongodb.net) connection failure points at Network Access (IP allow-list)', async () => {
    // A TLS handshake alert - exactly what Atlas returns for a non-allow-listed IP.
    state.behavior = { ping: () => Promise.reject(new Error('tlsv1 alert internal error')) };
    const atlas = new MongodbConnector({ id: 'm', name: 'm', connectionString: 'mongodb+srv://u:p@cluster0.abc12.mongodb.net', database: 'appdb' });
    await expect(atlas.connect()).rejects.toMatchObject({
      code: 'DB_UNREACHABLE',
      userMessage: expect.stringMatching(/Network Access/i),
    });
  });
});

describe('aggregate error mapping', () => {
  it('maps MaxTimeMSExpired to DB_TIMEOUT', async () => {
    state.behavior = {
      hasNext: () =>
        Promise.reject(
          Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired' }),
        ),
    };
    await expect(connector().aggregate('users', [])).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
  });

  it('maps any other cursor failure to DB_QUERY_ERROR', async () => {
    state.behavior = { hasNext: () => Promise.reject(new Error('$unknownStage is not allowed')) };
    await expect(connector().aggregate('users', [])).rejects.toMatchObject({
      code: 'DB_QUERY_ERROR',
      userMessage: 'The query failed: $unknownStage is not allowed',
    });
  });
});
