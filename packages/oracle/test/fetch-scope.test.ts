/**
 * Regression: fetch coercion (NUMBER/CLOB -> string, BLOB -> Buffer) must be
 * scoped per-execute via fetchTypeHandler, never the process-global
 * oracledb.fetchAsString/fetchAsBuffer - a host app also using oracledb must keep
 * its own fetch defaults. Mocks the driver and inspects the execute options.
 */
import { describe, expect, it, vi } from 'vitest';
import { OracleConnector } from '../src/index.js';

const h = vi.hoisted(() => ({
  execOptions: undefined as Record<string, unknown> | undefined,
  mod: {
    OUT_FORMAT_ARRAY: 4001,
    OUT_FORMAT_OBJECT: 4002,
    CLOB: 2017,
    BLOB: 2019,
    NUMBER: 2010,
    STRING: 2001,
    BUFFER: 2003,
    fetchAsString: [] as number[],
    fetchAsBuffer: [] as number[],
    createPool: async () => ({
      getConnection: async () => ({
        callTimeout: 0,
        async execute(sql: string, _binds: unknown, options: Record<string, unknown>) {
          if (sql.startsWith('SET TRANSACTION')) return {};
          h.execOptions = options;
          return { rows: [['1']], metaData: [{ name: 'ID', dbTypeName: 'NUMBER' }] };
        },
        async commit() {},
        async rollback() {},
        async close() {},
      }),
      close: async () => {},
    }),
  },
}));

vi.mock('oracledb', () => ({ default: h.mod }));

describe('per-execute fetch coercion, global singleton untouched', () => {
  it('leaves oracledb.fetchAsString/fetchAsBuffer alone and applies a fetchTypeHandler', async () => {
    const conn = new OracleConnector({ id: 'o', name: 'o', host: 'db.example', database: 'XEPDB1' });
    const res = await conn.execute('SELECT id FROM t');
    expect(res.rowCount).toBe(1);

    // The module-global fetch defaults must remain exactly as the host set them.
    expect(h.mod.fetchAsString).toEqual([]);
    expect(h.mod.fetchAsBuffer).toEqual([]);

    // Coercion is carried per-call instead.
    const handler = h.execOptions?.['fetchTypeHandler'] as (m: { dbTypeName: string }) => unknown;
    expect(typeof handler).toBe('function');
    expect(handler({ dbTypeName: 'NUMBER' })).toEqual({ type: h.mod.STRING });
    expect(handler({ dbTypeName: 'CLOB' })).toEqual({ type: h.mod.STRING });
    expect(handler({ dbTypeName: 'BLOB' })).toEqual({ type: h.mod.BUFFER });
    expect(handler({ dbTypeName: 'VARCHAR2' })).toBeUndefined();
    await conn.close();
  });
});
