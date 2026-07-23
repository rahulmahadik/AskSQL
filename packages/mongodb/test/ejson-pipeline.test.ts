/**
 * Regression: the connector must deserialize the pipeline's Extended JSON
 * ({"$date":..}, {"$oid":..}) into real BSON before running it, or a $match on a
 * date/ObjectId silently matches nothing. This mocks the driver with a spy on
 * aggregate + an EJSON that turns {$date} into a Date, and asserts the pipeline
 * reaching the driver carries real types.
 */
import { describe, expect, it, vi } from 'vitest';

const aggregateCalls: unknown[][] = [];

vi.mock('mongodb', () => {
  const deserialize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(deserialize);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['$date'] === 'string') return new Date(o['$date']);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) out[k] = deserialize(val);
      return out;
    }
    return v;
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
            return {
              hasNext: async () => false,
              next: async () => null,
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

describe('pipeline Extended JSON is deserialized before execution', () => {
  it('turns {"$date": ...} into a real Date in the pipeline reaching the driver', async () => {
    aggregateCalls.length = 0;
    const conn = new MongodbConnector({ id: 'm', name: 'M', connectionString: 'mongodb://x', database: 'db' });
    await conn.connect();
    await conn.aggregate('orders', [{ $match: { placedAt: { $gte: { $date: '2024-07-01T00:00:00Z' } } } }]);
    const sent = aggregateCalls[0]! as { $match: { placedAt: { $gte: unknown } } }[];
    // The $date literal became a Date, and a $limit probe was appended.
    expect(sent[0]!.$match.placedAt.$gte).toBeInstanceOf(Date);
    expect(sent[sent.length - 1]).toHaveProperty('$limit');
    await conn.close();
  });
});
