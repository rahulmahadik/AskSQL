/**
 * Connect-time error mapping with the mysql2 driver mocked - no server needed.
 */

import { describe, expect, it, vi } from 'vitest';
import { MysqlConnector } from '../src/index.js';

const state = vi.hoisted(() => ({
  getConnection: undefined as unknown as () => Promise<unknown>,
}));

vi.mock('mysql2/promise', () => ({
  createPool: () => ({
    getConnection: () => state.getConnection(),
    query: async () => [[], []],
    end: async () => {},
  }),
}));

function connector(): MysqlConnector {
  return new MysqlConnector({ id: 'm', name: 'm', host: 'db.example', database: 'app' });
}

describe('connect error mapping', () => {
  // The server answered and named the missing database; advising a host/port check would be wrong.
  it('maps ER_BAD_DB_ERROR to DB_NOT_FOUND, not DB_UNREACHABLE', async () => {
    state.getConnection = async () => {
      throw Object.assign(new Error("Unknown database 'nope'"), { code: 'ER_BAD_DB_ERROR' });
    };
    await expect(connector().connect()).rejects.toMatchObject({ name: 'AskSqlError', code: 'DB_NOT_FOUND' });
  });

  it('maps ER_ACCESS_DENIED_ERROR to DB_AUTH', async () => {
    state.getConnection = () =>
      Promise.reject(
        Object.assign(new Error("Access denied for user 'app'@'localhost'"), { code: 'ER_ACCESS_DENIED_ERROR' }),
      );
    await expect(connector().connect()).rejects.toMatchObject({ name: 'AskSqlError', code: 'DB_AUTH' });
  });

  it('maps a refused connection to DB_UNREACHABLE', async () => {
    state.getConnection = () =>
      Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' }));
    await expect(connector().connect()).rejects.toMatchObject({ code: 'DB_UNREACHABLE' });
  });
});
