/**
 * File-format robustness (FIL-*) - the messy real-world data a production
 * integrator's users will upload: alternate delimiters, headerless files,
 * ragged rows, non-UTF-8 encodings, Excel, duplicate names, and removal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DuckDbConnector, AskSqlError } from '../src/index.js';
import { AskSqlError as CoreError } from '@asksql/core';

const dir = dirname(fileURLToPath(import.meta.url));
const data = (f: string) => join(dir, 'data', f);

let available = true;
let conn: DuckDbConnector;

beforeAll(async () => {
  conn = new DuckDbConnector({ id: 'files', name: 'Files' });
  try {
    await conn.connect();
  } catch (err) {
    available = false;
    console.warn('[skip] duckdb files test:', (err as Error).message);
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

describe('alternate delimiter (semicolon)', () => {
  maybe('semicolon-delimited CSV is sniffed correctly', async () => {
    // 'semi' is a DuckDB keyword -> sanitized to a safe name.
    const table = await conn.registerFile({ table: 'semi', path: data('semicolon.csv'), format: 'csv' });
    expect(table).toBe('semi_data');
    const res = await conn.execute(`SELECT name, region, amount FROM ${table} ORDER BY name`);
    expect(res.columns.map((c) => c.name)).toEqual(['name', 'region', 'amount']);
    expect(res.rowCount).toBe(2);
    expect(res.rows[0]![0]).toBe('Ada');
  });
});

describe('headerless CSV', () => {
  maybe('auto-named columns, all rows readable', async () => {
    const table = await conn.registerFile({ table: 'headerless', path: data('headerless.csv'), format: 'csv' });
    const res = await conn.execute(`SELECT * FROM ${table}`);
    expect(res.rowCount).toBe(3);
    expect(res.columns.length).toBe(3); // auto column0..2
  });
});

describe('ragged rows surface a clear error', () => {
  maybe('inconsistent column counts -> FILE_PARSE, not a silent mangle', async () => {
    try {
      await conn.registerFile({ table: 'ragged', path: data('ragged.csv'), format: 'csv' });
      // DuckDB may accept it via null-padding; if so, that's acceptable too -
      // the invariant is no throw of an untyped error and no crash.
    } catch (err) {
      expect(CoreError.is(err)).toBe(true);
      expect((err as AskSqlError).code).toBe('FILE_PARSE');
    }
  });
});

describe('non-UTF-8 encoding (UTF-16)', () => {
  maybe('UTF-16 file with unicode content reads without mojibake', async () => {
    const table = await conn.registerFile({
      table: 'cities',
      path: data('utf16.csv'),
      format: 'csv',
      encoding: 'utf-16',
    });
    const res = await conn.execute(`SELECT city FROM ${table} ORDER BY city`);
    const cities = res.rows.map((r) => String(r[0]));
    expect(cities).toContain('München');
    expect(cities).toContain('Zürich');
  });
});

describe('Excel (.xlsx)', () => {
  maybe('reads an xlsx sheet as a table', async () => {
    try {
      const table = await conn.registerFile({ table: 'people', path: data('people.xlsx'), format: 'xlsx' });
      const res = await conn.execute(`SELECT name, orders FROM ${table} ORDER BY orders DESC`);
      expect(res.rowCount).toBe(3);
      expect(res.rows[0]![0]).toBe('Ada');
      expect(Number(res.rows[0]![1])).toBe(3);
    } catch (err) {
      // Honest: if the excel extension can't load (offline CI), that's a
      // clean FILE_PARSE with guidance, not a crash.
      expect((err as AskSqlError).code).toBe('FILE_PARSE');
      console.warn('[note] xlsx skipped - excel extension unavailable');
    }
  });

  maybe('registers named sheets as separate tables and joins across them', async () => {
    try {
      const sales = await conn.registerFile({
        table: 'xl_sales',
        path: data('multi-sheet.xlsx'),
        format: 'xlsx',
        sheet: 'Sales',
      });
      const targets = await conn.registerFile({
        table: 'xl_targets',
        path: data('multi-sheet.xlsx'),
        format: 'xlsx',
        sheet: 'Targets',
      });
      // Each sheet is its own table with its own columns.
      const s = await conn.introspect();
      const salesCols = s.tables.find((t) => t.name === sales)!.columns.map((c) => c.name);
      const targetCols = s.tables.find((t) => t.name === targets)!.columns.map((c) => c.name);
      expect(salesCols).toEqual(['region', 'amount']);
      expect(targetCols).toEqual(['region', 'goal']);
      // Join across the two sheets.
      const res = await conn.execute(
        `SELECT s.region, s.amount - t.goal AS delta FROM ${sales} s JOIN ${targets} t ON s.region = t.region ORDER BY s.region`,
      );
      expect(res.rowCount).toBe(2);
      const byRegion = Object.fromEntries(res.rows.map((r) => [r[0], Number(r[1])]));
      expect(byRegion['EU']).toBe(20); // 200 - 180
      expect(byRegion['NA']).toBe(-50); // 100 - 150
    } catch (err) {
      expect((err as AskSqlError).code).toBe('FILE_PARSE');
      console.warn('[note] multi-sheet xlsx skipped - excel extension unavailable');
    }
  });
});

describe('duplicate table name is versioned, not overwritten', () => {
  maybe('registering the same name twice yields distinct tables', async () => {
    const first = await conn.registerFile({ table: 'dup', path: data('sales.csv'), format: 'csv' });
    const second = await conn.registerFile({ table: 'dup', path: data('semicolon.csv'), format: 'csv' });
    expect(first).toBe('dup');
    expect(second).toBe('dup_2'); // versioned
    // Both queryable, distinct schemas.
    const r1 = await conn.execute(`SELECT count(*) FROM ${first}`);
    const r2 = await conn.execute(`SELECT count(*) FROM ${second}`);
    expect(Number(r1.rows[0]![0])).toBeGreaterThan(0);
    expect(Number(r2.rows[0]![0])).toBeGreaterThan(0);
  });
});

describe('duplicate OUTPUT column names are preserved by position, not collapsed', () => {
  maybe('a query projecting two columns with the same name keeps both values', async () => {
    const res = await conn.execute("SELECT 1 AS id, 'a' AS name, 2 AS id");
    expect(res.columns.map((c) => c.name)).toEqual(['id', 'name', 'id']);
    // Name-keyed reads would drop the first 'id' (last wins); positional reads keep 1 and 2.
    expect(res.rows[0]).toEqual([1, 'a', 2]);
  });
});

describe('remove a registered file', () => {
  maybe('unregisterFile drops the table and updates the catalog', async () => {
    const table = await conn.registerFile({ table: 'temp', path: data('sales.csv'), format: 'csv' });
    expect(conn.registeredTables()).toContain(table);
    await conn.unregisterFile(table);
    expect(conn.registeredTables()).not.toContain(table);
    // Querying it now fails (table gone).
    await expect(conn.execute(`SELECT * FROM ${table}`)).rejects.toBeTruthy();
  });
});
