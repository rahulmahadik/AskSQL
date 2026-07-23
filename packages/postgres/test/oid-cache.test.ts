/**
 * Regression: the OID->typename cache must be published atomically. A previous
 * version assigned an empty Map before the pg_type round-trip completed, so a
 * concurrent cold-start execute saw the non-null-but-empty map and typed a
 * non-core column (here uuid, oid 2950) as 'unknown'. Two concurrent executes
 * that both start before pg_type resolves must both see the resolved type name.
 */
import { describe, expect, it, vi } from 'vitest';
import { PostgresConnector } from '../src/index.js';

const hooks = vi.hoisted(() => ({
  pgType: null as null | { promise: Promise<{ rows: unknown[] }>; resolve: (v: { rows: unknown[] }) => void },
}));

vi.mock('pg', () => {
  class Pool {
    async connect() {
      return {
        processID: 1,
        async query(arg: unknown) {
          // Object form = the real query (rowMode 'array'); return one uuid column.
          if (typeof arg === 'object') {
            return { fields: [{ name: 'gid', dataTypeID: 2950 }], rows: [['x']], rowCount: 1 };
          }
          // Cache warm-up runs on the checked-out client (not the pool) to avoid pool deadlock.
          if (typeof arg === 'string' && /pg_type/.test(arg)) return hooks.pgType!.promise;
          // BEGIN / SET LOCAL / COMMIT / ROLLBACK.
          return { rows: [], fields: [], rowCount: 0 };
        },
        release() {},
      };
    }
    async end() {}
    async query(text: string) {
      if (/pg_type/.test(text)) return hooks.pgType!.promise;
      return { rows: [] };
    }
  }
  return { Pool, types: { setTypeParser: () => {} } };
});

describe('OID->typename cache is published atomically', () => {
  it('two concurrent cold-start executes both resolve the non-core column type', async () => {
    let resolve!: (v: { rows: unknown[] }) => void;
    const promise = new Promise<{ rows: unknown[] }>((r) => (resolve = r));
    hooks.pgType = { promise, resolve };

    const conn = new PostgresConnector({ id: 'p', name: 'p', host: 'db.example', database: 'app' });
    await conn.connect();

    const p1 = conn.execute('SELECT gid FROM t');
    const p2 = conn.execute('SELECT gid FROM t');
    // Let both reach the pg_type warm-up await, then complete the round-trip.
    await new Promise((r) => setImmediate(r));
    resolve({ rows: [{ oid: 2950, typname: 'uuid' }] });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.columns[0]!.dbType).toBe('uuid');
    expect(r2.columns[0]!.dbType).toBe('uuid');
    await conn.close();
  });
});
