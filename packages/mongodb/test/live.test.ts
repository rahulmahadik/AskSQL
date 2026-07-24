/**
 * Live MongoDB test against a local server (see internal/LOCAL-DBS.md). Skips cleanly when none is
 * reachable, so CI without Mongo stays green. Seeds via the raw driver, then exercises the connector -
 * including the discrete user/password path (authSource must default to `admin`, not the query db).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongodbConnector } from '../src/index.js';

const HOST = process.env['ASKSQL_MONGO_HOST'] ?? 'localhost:27017';
const USER = process.env['ASKSQL_MONGO_USER'] ?? 'root';
const PASS = process.env['ASKSQL_MONGO_PASS'] ?? 'secret';
const DB = 'asksql_live_test';
const withCreds = `mongodb://${USER}:${PASS}@${HOST}`;

let ready = false;

beforeAll(async () => {
  let MongoClient: typeof import('mongodb').MongoClient;
  try {
    ({ MongoClient } = await import('mongodb'));
  } catch {
    return; // driver not installed
  }
  const client = new MongoClient(withCreds, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    const db = client.db(DB);
    await db.collection('orders').deleteMany({});
    await db.collection('orders').insertMany([
      { _id: 1, customerId: 1, total: 5000, status: 'paid' },
      { _id: 2, customerId: 1, total: 2500, status: 'pending' },
      { _id: 3, customerId: 2, total: 9900, status: 'paid' },
    ]);
    ready = true;
  } catch (err) {
    console.warn('[skip] mongo live test - no server reachable:', (err as Error).message);
  } finally {
    await client.close().catch(() => {});
  }
}, 20_000);

const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => (ready ? fn() : undefined), 15_000);

describe('MongoDB connector (live)', () => {
  maybe('introspects collections and runs an aggregate (creds in the connection string)', async () => {
    const c = new MongodbConnector({ id: 'm', name: 'm', database: DB, connectionString: withCreds });
    await c.connect();
    const cat = await c.introspect();
    expect(cat.tables.some((t) => t.name === 'orders')).toBe(true);
    const res = await c.aggregate('orders', [{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
    expect(res.rows).toEqual([
      ['paid', 2],
      ['pending', 1],
    ]);
    await c.close();
  });

  maybe('discrete user/password authenticates against admin by default (not the query db)', async () => {
    // With authSource wrongly defaulted to the query db, a root/admin user fails here.
    const c = new MongodbConnector({ id: 'm', name: 'm', database: DB, connectionString: `mongodb://${HOST}`, user: USER, password: PASS });
    await c.connect();
    const res = await c.aggregate('orders', [{ $count: 'n' }]);
    expect(Number(res.rows[0]![0])).toBe(3);
    await c.close();
  });
});
