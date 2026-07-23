/**
 * Regression coverage for two connector defects:
 *  - Strict EJSON: {"$numberLong": "..."} must survive as a BSON Long, not a
 *    lossy JS double, so a 64-bit filter value reaches the query intact.
 *  - Truncation: the guard's trailing $limit masks the connector's overshoot
 *    probe, so a full result (docs filling the cap) must still report truncated.
 * Mocks the driver with an EJSON that honours { relaxed: false } and a cursor
 * fed from a fixed doc array.
 */
import { describe, expect, it, vi } from 'vitest';

const aggregateCalls: unknown[][] = [];
let cursorDocs: Record<string, unknown>[] = [];

class FakeLong {
  readonly _bsontype = 'Long';
  constructor(private readonly s: string) {}
  toString(): string {
    return this.s;
  }
}

vi.mock('mongodb', () => {
  const deserialize = (value: unknown, options?: { relaxed?: boolean }): unknown => {
    if (Array.isArray(value)) return value.map((v) => deserialize(v, options));
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o['$numberLong'] === 'string') {
        // Relaxed (the default) collapses to a lossy double; strict keeps a Long.
        return options?.relaxed === false ? new FakeLong(o['$numberLong']) : Number(o['$numberLong']);
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) out[k] = deserialize(val, options);
      return out;
    }
    return value;
  };
  class MongoClient {
    async connect() {
      return this;
    }
    async close() {}
    db() {
      return {
        command: async () => ({ ok: 1 }),
        collection: () => ({
          aggregate: (pipeline: unknown[]) => {
            aggregateCalls.push(pipeline);
            let i = 0;
            return {
              hasNext: async () => i < cursorDocs.length,
              next: async () => (i < cursorDocs.length ? cursorDocs[i++]! : null),
              close: async () => {},
            };
          },
        }),
      };
    }
  }
  return { MongoClient, EJSON: { deserialize } };
});

const { MongodbConnector } = await import('../src/index.js');

function connector() {
  return new MongodbConnector({ id: 'm', name: 'M', connectionString: 'mongodb://x', database: 'db' });
}

describe('strict EJSON preserves 64-bit filter values', () => {
  it('keeps {"$numberLong": ...} a BSON Long into the query filter', async () => {
    aggregateCalls.length = 0;
    cursorDocs = [];
    const conn = connector();
    await conn.connect();
    const big = '9223372036854775807';
    await conn.aggregate('accounts', [{ $match: { balance: { $eq: { $numberLong: big } } } }]);
    const sent = aggregateCalls[0]! as { $match: { balance: { $eq: unknown } } }[];
    const eq = sent[0]!.$match.balance.$eq as { _bsontype?: string; toString(): string };
    expect(eq._bsontype).toBe('Long');
    expect(eq.toString()).toBe(big); // exact - never a lossy double
    await conn.close();
  });
});

describe('truncation is derived from filling the cap', () => {
  it('reports truncated when the result fills maxRows', async () => {
    aggregateCalls.length = 0;
    cursorDocs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const conn = connector();
    await conn.connect();
    const res = await conn.aggregate('c', [{ $match: {} }], { maxRows: 3 });
    expect(res.truncated).toBe(true);
    expect(res.rowCount).toBe(3);
    await conn.close();
  });

  it('does not report truncated for a partial result', async () => {
    aggregateCalls.length = 0;
    cursorDocs = [{ id: 1 }, { id: 2 }];
    const conn = connector();
    await conn.connect();
    const res = await conn.aggregate('c', [{ $match: {} }], { maxRows: 3 });
    expect(res.truncated).toBe(false);
    expect(res.rowCount).toBe(2);
    await conn.close();
  });
});
