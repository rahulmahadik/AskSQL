/**
 * Connect-time error mapping with the pg driver mocked - no server needed.
 */

import { describe, expect, it, vi } from 'vitest';
import { PostgresConnector } from '../src/index.js';

const state = vi.hoisted(() => ({
  connect: undefined as unknown as () => Promise<unknown>,
}));

vi.mock('pg', () => {
  class Pool {
    connect(): Promise<unknown> {
      return state.connect();
    }
    async end(): Promise<void> {}
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] };
    }
  }
  return { Pool, types: { setTypeParser: () => {} } };
});

function connector(): PostgresConnector {
  return new PostgresConnector({ id: 'p', name: 'p', host: 'db.example', database: 'app' });
}

describe('connect error mapping', () => {
  it('maps 28P01 (invalid password) to DB_AUTH', async () => {
    state.connect = () =>
      Promise.reject(Object.assign(new Error('password authentication failed for user "app"'), { code: '28P01' }));
    await expect(connector().connect()).rejects.toMatchObject({ name: 'AskSqlError', code: 'DB_AUTH' });
  });

  it('maps a refused connection to DB_UNREACHABLE', async () => {
    state.connect = () =>
      Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
    await expect(connector().connect()).rejects.toMatchObject({ code: 'DB_UNREACHABLE' });
  });
});
