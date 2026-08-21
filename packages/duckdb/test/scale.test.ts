/**
 * introspect() used to read columns with runAndReadUntil(sql, 100_000): that call reads until AT
 * LEAST 100,000 rows (one row per column, across the whole database), overshooting by up to one
 * ~2048-row chunk, then stops with no signal anything was cut. A schema wide enough that the overshoot
 * cannot cover the remainder lost every column past that point. 8001 tables x 25 columns is comfortably
 * past both the target and the largest possible overshoot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DuckDbConnector } from '../src/index.js';

describe('SCALE: introspection reads the whole catalog past the old row-count cap', () => {
  let conn: DuckDbConnector | undefined;
  afterEach(async () => {
    await conn?.close();
    conn = undefined;
  });

  it('does not truncate a schema with more than 100,000 total columns', async () => {
    conn = new DuckDbConnector({ id: 'x', name: 'x', database: ':memory:' });
    await conn.connect();
    const TABLES = 8001;
    const COLS = 25;
    for (let t = 0; t < TABLES; t++) {
      const cols = Array.from({ length: COLS }, (_, i) => `c${i} INTEGER`).join(', ');
      await conn.execute(`CREATE TABLE t${t} (${cols})`);
    }
    const catalog = await conn.introspect();
    expect(catalog.tables.length).toBe(TABLES);
    const totalCols = catalog.tables.reduce((n, t) => n + t.columns.length, 0);
    expect(totalCols).toBe(TABLES * COLS);
    // The last table by creation order must have kept all its columns, not just an early prefix.
    const last = catalog.tables.find((t) => t.name === `t${TABLES - 1}`);
    expect(last?.columns.length).toBe(COLS);
  }, 30_000);
});
