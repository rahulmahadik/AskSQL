/**
 * A database file is opened READ_ONLY, like the SQLite connector's {readonly, fileMustExist}:
 * a missing path must not be created, a write must be refused, and access_mode is read back so an
 * option the driver ignored cannot leave a writable handle in use. `:memory:` and a connector that
 * registers files still need to write. Runs against a real DuckDB.
 */

import { AskSqlError } from '@asksql/core';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDbConnector } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'asksql-duck-ro-'));
const dbFile = join(dir, 'shop.duckdb');
const csvFile = join(dir, 'sales.csv');
let available = true;

beforeAll(async () => {
  writeFileSync(csvFile, 'id,amount\n1,10\n');
  try {
    // Seed through the driver: the connector itself no longer opens a file for writing.
    const { DuckDBInstance } = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: { create(path: string): Promise<{ connect(): Promise<{ run(sql: string): Promise<unknown> }> }> };
    };
    const conn = await (await DuckDBInstance.create(dbFile)).connect();
    await conn.run('CREATE TABLE sales(id INT); INSERT INTO sales VALUES (1);');
  } catch (err) {
    available = false;
    console.warn('[skip] DuckDB engine not available:', (err as Error).message);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (available) await fn();
  });

describe('a database file is opened read-only', () => {
  maybe('refuses a path that does not exist instead of creating it', async () => {
    const missing = join(dir, 'absent.duckdb');
    const c = new DuckDbConnector({ id: 'a', name: 'a', path: missing });
    await expect(c.connect()).rejects.toMatchObject({ name: 'AskSqlError', code: 'CONFIG_ERROR' });
    expect(existsSync(missing)).toBe(false);
  });

  maybe('reads rows but refuses a write', async () => {
    const c = new DuckDbConnector({ id: 'b', name: 'b', path: dbFile });
    await c.connect();
    await expect(c.execute('SELECT id FROM sales')).resolves.toMatchObject({ rowCount: 1 });
    await expect(c.execute('CREATE TABLE evil(a INT)')).rejects.toThrow(AskSqlError);
    await c.close();
  });

  maybe('reads access_mode back as read_only', async () => {
    const c = new DuckDbConnector({ id: 'c', name: 'c', path: dbFile });
    await c.connect();
    const r = await c.execute("SELECT current_setting('access_mode') AS m");
    expect(r.rows[0]![0]).toBe('read_only');
    await c.close();
  });

  maybe('leaves :memory: writable', async () => {
    const mem = new DuckDbConnector({ id: 'm', name: 'm' });
    await mem.connect();
    await expect(mem.execute('CREATE TABLE t(a INT)')).resolves.toBeTruthy();
    await mem.close();
  });

  maybe('leaves a connector that registers files writable', async () => {
    const withFiles = new DuckDbConnector({
      id: 'f',
      name: 'f',
      path: join(dir, 'files.duckdb'),
      files: [{ table: 'sales', path: csvFile, format: 'csv' }],
    });
    await withFiles.connect();
    expect(withFiles.registeredTables()).toEqual(['sales']);
    await withFiles.close();
  });
});
