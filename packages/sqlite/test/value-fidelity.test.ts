/**
 * Value-fidelity boundaries for the SQLite connector: 64-bit integers beyond 2^53 mixed
 * with small values in ONE column (SQLite columns are dynamically typed per row), and
 * non-finite REALs (9e999 evaluates to Infinity, which JSON serializes to null).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteConnector } from '../src/index.js';

let conn: SqliteConnector;
beforeAll(async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE nums (id INTEGER PRIMARY KEY, v INTEGER);
    INSERT INTO nums (id, v) VALUES (1, 42), (2, 9223372036854775807), (3, -9223372036854775808);
  `);
  conn = new SqliteConnector({ id: 'fid', name: 'Fidelity', database: db as never });
  await conn.connect();
});

describe('mixed-magnitude integer column', () => {
  it('one column never mixes number cells with string cells', async () => {
    const rs = await conn.execute('SELECT v FROM nums ORDER BY id');
    const kinds = new Set(rs.rows.map((r) => typeof r[0]));
    expect([...kinds]).toEqual(['string']);
    // And the declared column kind matches the cells.
    expect(rs.columns[0]!.kind).toBe('bigint');
  });

  it('64-bit extremes round-trip digit for digit', async () => {
    const rs = await conn.execute('SELECT v FROM nums WHERE id >= 2 ORDER BY id');
    expect(rs.rows[0]![0]).toBe('9223372036854775807');
    expect(rs.rows[1]![0]).toBe('-9223372036854775808');
  });

  it('an all-small column still uses plain numbers', async () => {
    const rs = await conn.execute('SELECT id FROM nums ORDER BY id');
    expect(rs.columns[0]!.kind).toBe('number');
    expect(rs.rows.map((r) => r[0])).toEqual([1, 2, 3]);
  });
});

describe('non-finite REAL', () => {
  it('9e999 (Infinity) serializes as a string, not JSON null', async () => {
    const rs = await conn.execute('SELECT 9e999 AS inf, -9e999 AS ninf');
    expect(rs.rows[0]![0]).toBe('Infinity');
    expect(rs.rows[0]![1]).toBe('-Infinity');
    expect(JSON.stringify(rs.rows)).not.toContain('null');
  });
});
