/**
 * Error mapping with the oracledb driver mocked - no database needed.
 * Covers connect-time auth/unreachable classification and query-time
 * timeout / read-only mapping.
 */

import { describe, expect, it, vi } from 'vitest';
import { OracleConnector } from '../src/index.js';

const driver = vi.hoisted(() => ({
  createPool: undefined as unknown as (config: Record<string, unknown>) => Promise<unknown>,
}));

vi.mock('oracledb', () => ({
  default: {
    OUT_FORMAT_ARRAY: 4001,
    OUT_FORMAT_OBJECT: 4002,
    CLOB: 2017,
    BLOB: 2019,
    NUMBER: 2010,
    fetchAsString: [],
    fetchAsBuffer: [],
    createPool: (config: Record<string, unknown>) => driver.createPool(config),
  },
}));

function connector(): OracleConnector {
  return new OracleConnector({ id: 'o', name: 'o', host: 'db.example', database: 'XEPDB1' });
}

function oraError(message: string, errorNum: number): Error {
  return Object.assign(new Error(message), { errorNum });
}

/** Pool whose connections run SET TRANSACTION fine and fail the real query. */
function poolFailingQueryWith(err: Error): unknown {
  const conn = {
    callTimeout: 0,
    async execute(sql: string) {
      if (sql.startsWith('SET TRANSACTION')) return {};
      throw err;
    },
    async commit() {},
    async rollback() {},
    async close() {},
  };
  return { getConnection: async () => conn, close: async () => {} };
}

describe('connect error mapping', () => {
  it('maps ORA-01017 to DB_AUTH', async () => {
    driver.createPool = () => Promise.reject(oraError('ORA-01017: invalid username/password; logon denied', 1017));
    await expect(connector().connect()).rejects.toMatchObject({ name: 'AskSqlError', code: 'DB_AUTH' });
  });

  it('maps a failed connection attempt to DB_UNREACHABLE and closes the pool', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    driver.createPool = async () => ({
      getConnection: () => Promise.reject(new Error('NJS-501: connection to host db.example:1521 refused')),
      close,
    });
    await expect(connector().connect()).rejects.toMatchObject({ code: 'DB_UNREACHABLE' });
    expect(close).toHaveBeenCalled();
  });
});

describe('query error mapping', () => {
  it('maps ORA-01013 (call timeout) to DB_TIMEOUT', async () => {
    driver.createPool = async () => poolFailingQueryWith(oraError('ORA-01013: user requested cancel', 1013));
    await expect(connector().execute('SELECT 1 FROM DUAL')).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
  });

  it('maps ORA-01456 (write in read-only transaction) to GUARD_BLOCKED', async () => {
    driver.createPool = async () =>
      poolFailingQueryWith(oraError('ORA-01456: may not perform insert/delete/update operation', 1456));
    await expect(connector().execute('DELETE FROM t')).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
  });

  it('maps any other failure to DB_QUERY_ERROR with a first-line user message', async () => {
    driver.createPool = async () =>
      poolFailingQueryWith(oraError('ORA-00942: table or view does not exist\nextra detail', 942));
    await expect(connector().execute('SELECT * FROM missing')).rejects.toMatchObject({
      code: 'DB_QUERY_ERROR',
      userMessage: 'The query failed: ORA-00942: table or view does not exist',
    });
  });
});
