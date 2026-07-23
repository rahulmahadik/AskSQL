/**
 * Live MySQL connector tests against the shops/products fixture.
 * Set ASKSQL_MYSQL_URL or rely on the local default. Skips if unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MysqlConnector } from '../src/index.js';
import { AskSqlError } from '@asksql/core';

const conn = new MysqlConnector({
  id: 'my',
  name: 'Shop MySQL',
  host: process.env['ASKSQL_MYSQL_HOST'] ?? '127.0.0.1',
  port: Number(process.env['ASKSQL_MYSQL_PORT'] ?? 3306),
  user: process.env['ASKSQL_MYSQL_USER'] ?? 'root',
  password: process.env['ASKSQL_MYSQL_PASSWORD'] ?? '',
  database: process.env['ASKSQL_MYSQL_DB'] ?? 'asksql_test',
});

let available = true;
beforeAll(async () => {
  try {
    await conn.connect();
  } catch (err) {
    available = false;
    console.warn('[skip] MySQL not reachable:', (err as Error).message);
  }
});
afterAll(async () => {
  await conn.close();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  });

describe('MySQL introspection', () => {
  maybe('tables, view, PK, FK, unique, index, enum, comments', async () => {
    const cat = await conn.introspect();
    const products = cat.tables.find((t) => t.name === 'products')!;
    expect(products.primaryKey).toEqual(['id']);
    expect(products.foreignKeys[0]).toMatchObject({ refTable: 'shops', columns: ['shop_id'] });
    expect(products.uniques.some((u) => u.includes('shop_id') && u.includes('sku'))).toBe(true);
    expect(products.indexes.some((i) => i.name === 'ix_products_price')).toBe(true);
    expect(products.comment).toMatch(/Products per shop/);

    const shops = cat.tables.find((t) => t.name === 'shops')!;
    const country = shops.columns.find((c) => c.name === 'country')!;
    expect(country.enumValues).toEqual(['US', 'UK', 'IN', 'DE']);

    expect(cat.tables.find((t) => t.name === 'in_stock')?.kind).toBe('view');
  });

  maybe('uri/DSN mode resolves the database and still introspects (database not set)', async () => {
    // With a connection string the database is selected by the DSN, not config.
    // The connector must resolve it (SELECT DATABASE()) rather than filter
    // information_schema on an empty name - which would return zero tables.
    const host = process.env['ASKSQL_MYSQL_HOST'] ?? '127.0.0.1';
    const port = Number(process.env['ASKSQL_MYSQL_PORT'] ?? 3306);
    const user = process.env['ASKSQL_MYSQL_USER'] ?? 'root';
    const password = process.env['ASKSQL_MYSQL_PASSWORD'] ?? '';
    const db = process.env['ASKSQL_MYSQL_DB'] ?? 'asksql_test';
    const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
    const c = new MysqlConnector({
      id: 'my-uri',
      name: 'Shop (uri)',
      uri: `mysql://${auth}@${host}:${port}/${db}`,
      database: '',
    });
    await c.connect();
    try {
      const cat = await c.introspect();
      expect(cat.tables.some((t) => t.name === 'products')).toBe(true);
    } finally {
      await c.close();
    }
  });

  maybe('triggers captured', async () => {
    const cat = await conn.introspect();
    const trg = cat.triggers.find((t) => t.name === 'trg_products_bi')!;
    expect(trg.table).toBe('products');
    expect(trg.timing).toBe('BEFORE');
    expect(trg.events).toContain('INSERT');
  });
});

describe('MySQL execution', () => {
  maybe('BIGINT fidelity preserved as string', async () => {
    const res = await conn.execute('SELECT price_cents FROM products ORDER BY price_cents DESC LIMIT 1');
    expect(res.rows[0]![0]).toBe('999999999999');
    expect(res.columns[0]!.kind).toBe('bigint');
  });

  maybe('DECIMAL fidelity preserved as string', async () => {
    const res = await conn.execute('SELECT weight FROM products WHERE weight IS NOT NULL ORDER BY weight DESC LIMIT 1');
    expect(res.rows[0]![0]).toBe('2.750');
  });

  maybe('join + aggregate', async () => {
    const res = await conn.execute(
      'SELECT s.name, count(p.id) n FROM shops s LEFT JOIN products p ON p.shop_id=s.id GROUP BY s.name ORDER BY s.name',
    );
    expect(res.rowCount).toBe(2);
  });

  maybe('read-only session rejects writes at the DB (bypassing guard)', async () => {
    await expect(conn.execute("INSERT INTO shops (name,country) VALUES ('x','US')")).rejects.toThrow();
  });

  maybe('row cap truncates', async () => {
    const res = await conn.execute('SELECT * FROM products', { maxRows: 1 });
    expect(res.truncated).toBe(true);
    expect(res.rowCount).toBe(1);
  });

  maybe('cancel via AbortSignal -> CANCELLED', async () => {
    const ac = new AbortController();
    const p = conn.execute('SELECT SLEEP(5)', { signal: ac.signal, timeoutMs: 10_000 });
    setTimeout(() => ac.abort(), 200);
    try {
      await p;
      throw new Error('should cancel');
    } catch (err) {
      expect((err as AskSqlError).code).toBe('CANCELLED');
    }
  });
});
