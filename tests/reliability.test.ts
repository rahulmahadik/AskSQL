/**
 * Reliability under real load against live Postgres - the cases a production
 * integrator hits first: pool exhaustion (more concurrent queries than
 * pool slots), concurrent queries not cross-wiring, and query-error recovery
 * recovery after an error. Uses a deliberately small pool to force queuing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresConnector } from '@asksql/postgres';
import { AskSqlError } from '@asksql/core';

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';
let ready = true;
// max: 2 so 20 concurrent queries must queue through 2 slots.
const conn = new PostgresConnector({ id: 'shop', name: 'Shop', connectionString: PG_URL, max: 2 });

beforeAll(async () => {
  try {
    await conn.connect();
  } catch {
    ready = false;
  }
});
afterAll(async () => {
  await conn.close();
});

const maybe = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(
    name,
    async () => {
      if (!ready) return;
      await fn();
    },
    timeout,
  );

describe('pool exhaustion queues, never deadlocks', () => {
  maybe('20 concurrent queries through a 2-connection pool all complete', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      conn.execute(`SELECT ${i} AS n, count(*) AS c FROM shop.customers`, { timeoutMs: 10_000 }),
    );
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(20);
    // each query returns ITS OWN value of n (no cross-wiring).
    for (let i = 0; i < 20; i++) {
      expect(Number(results[i]!.rows[0]![0])).toBe(i);
      expect(Number(results[i]!.rows[0]![1])).toBe(3);
    }
  });
});

describe('mixed concurrent queries stay isolated', () => {
  maybe('different queries fired together each get the right result', async () => {
    const [customers, orders, items] = await Promise.all([
      conn.execute('SELECT count(*) FROM shop.customers'),
      conn.execute('SELECT count(*) FROM shop.orders'),
      conn.execute('SELECT count(*) FROM shop.order_items'),
    ]);
    expect(Number(customers.rows[0]![0])).toBe(3);
    expect(Number(orders.rows[0]![0])).toBe(4);
    expect(Number(items.rows[0]![0])).toBe(3);
  });
});

describe('recovery after errors under concurrency', () => {
  maybe('a batch mixing failing and valid queries: failures isolated, valids succeed', async () => {
    const settled = await Promise.allSettled([
      conn.execute('SELECT * FROM shop.does_not_exist'), // errors
      conn.execute('SELECT count(*) FROM shop.customers'), // ok
      conn.execute('SELECT bad syntax here'), // errors
      conn.execute('SELECT count(*) FROM shop.orders'), // ok
    ]);
    expect(settled[0]!.status).toBe('rejected');
    expect(settled[1]!.status).toBe('fulfilled');
    expect(settled[2]!.status).toBe('rejected');
    expect(settled[3]!.status).toBe('fulfilled');
    // Pool is healthy afterwards.
    const after = await conn.execute('SELECT 1 AS ok');
    expect(Number(after.rows[0]![0])).toBe(1);
  });

  maybe('errors are typed, not raw', async () => {
    try {
      await conn.execute('SELECT * FROM shop.nope_table');
      throw new Error('should have thrown');
    } catch (err) {
      expect(AskSqlError.is(err)).toBe(true);
      expect((err as AskSqlError).code).toBe('DB_QUERY_ERROR');
      // Sanitized: no raw multi-line stack in the user message.
      expect((err as AskSqlError).userMessage.split('\n')).toHaveLength(1);
    }
  });
});
