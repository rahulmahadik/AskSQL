/**
 * Live Oracle test against a local Oracle Database Free instance (see
 * internal/LOCAL-DBS.md for the container). Skips cleanly when no DB is
 * reachable, so CI without Oracle stays green. Seeds via the raw driver
 * (the connector is read-only), then exercises the connector for reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OracleConnector } from '../src/index.js';
import type { Connector } from '@asksql/core';

const CFG = {
  host: process.env['ASKSQL_ORA_HOST'] ?? '127.0.0.1',
  port: Number(process.env['ASKSQL_ORA_PORT'] ?? 1521),
  user: process.env['ASKSQL_ORA_USER'] ?? 'asksql',
  password: process.env['ASKSQL_ORA_PASSWORD'] ?? 'asksql',
  database: process.env['ASKSQL_ORA_SERVICE'] ?? 'FREEPDB1',
};
const connectString = `${CFG.host}:${CFG.port}/${CFG.database}`;

let ready = false;
let conn: Connector;

const SEED = [
  `BEGIN EXECUTE IMMEDIATE 'DROP TABLE shop_orders'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
  `BEGIN EXECUTE IMMEDIATE 'DROP TABLE shop_customers'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
  `CREATE TABLE shop_customers (id NUMBER PRIMARY KEY, name VARCHAR2(100), region VARCHAR2(20))`,
  `CREATE TABLE shop_orders (id NUMBER PRIMARY KEY, customer_id NUMBER REFERENCES shop_customers(id), total_cents NUMBER, status VARCHAR2(20))`,
  `INSERT INTO shop_customers VALUES (1, 'Ada', 'EU')`,
  `INSERT INTO shop_customers VALUES (2, 'Grace', 'NA')`,
  `INSERT INTO shop_orders VALUES (10, 1, 5000, 'paid')`,
  `INSERT INTO shop_orders VALUES (11, 1, 2500, 'pending')`,
  `INSERT INTO shop_orders VALUES (12, 2, 9900, 'paid')`,
];

beforeAll(async () => {
  let oracledb: typeof import('oracledb');
  try {
    oracledb = (await import('oracledb')).default ?? (await import('oracledb'));
  } catch {
    return; // driver not installed
  }
  try {
    const c = await oracledb.getConnection({ user: CFG.user, password: CFG.password, connectString });
    for (const stmt of SEED) await c.execute(stmt);
    await c.commit();
    await c.close();
    ready = true;
  } catch (err) {
    console.warn('[skip] oracle live test - no DB reachable:', (err as Error).message);
    return;
  }
  conn = new OracleConnector({ id: 'ora', name: 'Oracle', ...CFG });
  await conn.connect();
}, 60_000);

afterAll(async () => {
  if (conn) await conn.close();
});

const maybe = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(name, async () => (ready ? fn() : undefined), timeout);

describe('Oracle connector (live)', () => {
  maybe(
    'introspects tables, columns and the foreign key',
    async () => {
      const cat = await conn.introspect();
      const orders = cat.tables.find((t) => t.name === 'SHOP_ORDERS');
      const customers = cat.tables.find((t) => t.name === 'SHOP_CUSTOMERS');
      expect(orders).toBeDefined();
      expect(customers).toBeDefined();
      expect(customers!.primaryKey).toContain('ID');
      expect(orders!.foreignKeys.some((fk) => fk.refTable === 'SHOP_CUSTOMERS')).toBe(true);
    },
    90_000, // ALL_* dictionary reads are slow under x86 emulation
  );

  maybe('runs a SELECT and returns rows', async () => {
    const res = await conn.execute('SELECT id, status FROM shop_orders ORDER BY id');
    expect(res.rowCount).toBe(3);
    expect(res.columns.map((c) => c.name)).toEqual(['ID', 'STATUS']);
    expect(String(res.rows[0]![1])).toBe('paid');
  });

  maybe('runs a join across the foreign key', async () => {
    const res = await conn.execute(
      `SELECT c.name, count(o.id) AS n FROM shop_customers c JOIN shop_orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY c.name`,
    );
    expect(res.rowCount).toBe(2);
  });

  maybe('the read-only session rejects a write even if one reaches the driver', async () => {
    await expect(conn.execute(`INSERT INTO shop_orders VALUES (99, 1, 1, 'x')`)).rejects.toBeTruthy();
    // The data is unchanged.
    const res = await conn.execute('SELECT count(*) FROM shop_orders');
    expect(Number(res.rows[0]![0])).toBe(3);
  });

  maybe('caps the fetch at maxRows (fetch-style dialect has no injected LIMIT)', async () => {
    const res = await conn.execute('SELECT id FROM shop_orders', { maxRows: 2 });
    expect(res.rows.length).toBe(2);
    expect(res.truncated).toBe(true);
  });
});
