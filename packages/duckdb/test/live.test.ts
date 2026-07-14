/**
 * DuckDB connector: file registration (CSV/JSON/Parquet), introspection,
 * querying, fidelity, and the file-function guard integration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DuckDbConnector, sanitizeTableName } from '../src/index.js';
import { guardSql, DUCKDB_DIALECT, AskSqlError } from '@asksql/core';

const dir = dirname(fileURLToPath(import.meta.url));
const data = (f: string) => join(dir, 'data', f);

let available = true;
const conn = new DuckDbConnector({
  id: 'duck',
  name: 'Files',
  files: [
    { table: 'sales', path: data('sales.csv'), format: 'csv' },
    { table: 'customers', path: data('customers.json'), format: 'json' },
    { table: 'sales_pq', path: data('sales.parquet'), format: 'parquet' },
  ],
});

beforeAll(async () => {
  try {
    await conn.connect();
  } catch (err) {
    available = false;
    console.warn('[skip] duckdb not available:', (err as Error).message);
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

describe('FIL - file registration + introspection', () => {
  maybe('registers CSV, JSON and Parquet as tables', async () => {
    const cat = await conn.introspect();
    const names = cat.tables.map((t) => t.name).sort();
    expect(names).toContain('sales');
    expect(names).toContain('customers');
    expect(names).toContain('sales_pq');
    expect(cat.tables.every((t) => t.source === 'file')).toBe(true);
  });

  maybe('infers columns and types from CSV', async () => {
    const cat = await conn.introspect();
    const sales = cat.tables.find((t) => t.name === 'sales')!;
    const cols = new Map(sales.columns.map((c) => [c.name, c.dbType]));
    expect([...cols.keys()].sort()).toEqual(['amount', 'customer', 'id', 'ordered_at', 'region']);
  });

  maybe('queries CSV with aggregation', async () => {
    const res = await conn.execute('SELECT region, count(*) n, sum(amount) total FROM sales GROUP BY region ORDER BY total DESC');
    expect(res.rowCount).toBe(3);
    expect(res.columns.map((c) => c.name)).toEqual(['region', 'n', 'total']);
  });

  maybe('joins CSV and JSON file tables', async () => {
    const res = await conn.execute(
      'SELECT c.name, sum(s.amount) spend FROM sales s JOIN customers c ON c.name = s.customer GROUP BY c.name ORDER BY spend DESC',
    );
    expect(res.rowCount).toBeGreaterThan(0);
  });

  maybe('large integer from JSON kept exact', async () => {
    const res = await conn.execute('SELECT name, lifetime_value FROM customers ORDER BY lifetime_value DESC LIMIT 1');
    expect(res.rows[0]![0]).toBe('Ada');
    // 5e12 exceeds nothing dangerous but must remain exact.
    expect(String(res.rows[0]![1])).toBe('5000000000000');
  });

  maybe('Parquet round-trips the same data as the CSV', async () => {
    const csv = await conn.execute('SELECT count(*) c FROM sales');
    const pq = await conn.execute('SELECT count(*) c FROM sales_pq');
    expect(pq.rows[0]![0]).toBe(csv.rows[0]![0]);
  });

  maybe('row cap truncates', async () => {
    const res = await conn.execute('SELECT * FROM sales', { maxRows: 2 });
    expect(res.rowCount).toBe(2);
    expect(res.truncated).toBe(true);
  });
});

describe('file-function guard integration', () => {
  it('server-mode guard blocks read_csv of arbitrary path', () => {
    const v = guardSql({ sql: "SELECT * FROM read_csv_auto('/etc/passwd')", dialect: DUCKDB_DIALECT, policy: { allowFileFunctions: false } });
    expect(v.allowed).toBe(false);
  });
  it('querying the registered table name is allowed (no path)', () => {
    const v = guardSql({ sql: 'SELECT * FROM sales', dialect: DUCKDB_DIALECT, policy: { allowFileFunctions: false } });
    expect(v.allowed).toBe(true);
  });
});

describe('table-name sanitization', () => {
  it('sanitizes unsafe filenames', () => {
    expect(sanitizeTableName('2024 sales!.csv')).toMatch(/^t_2024_sales_?$/);
    expect(sanitizeTableName('orders.csv')).toBe('orders');
    // Reserved keyword -> suffixed so an unquoted `FROM select` can't break.
    expect(sanitizeTableName('select.csv')).toBe('select_data');
  });
});

describe('bad file surfaces FILE_PARSE', () => {
  it('missing file -> FILE_PARSE', async () => {
    if (!available) return;
    const bad = new DuckDbConnector({ id: 'b', name: 'b' });
    await bad.connect();
    try {
      await bad.registerFile({ table: 'x', path: '/nonexistent/nope.csv', format: 'csv' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(AskSqlError.is(err)).toBe(true);
      expect((err as AskSqlError).code).toBe('FILE_PARSE');
    } finally {
      await bad.close();
    }
  });
});
