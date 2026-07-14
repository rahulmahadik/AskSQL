/**
 * Regression tests for the security-audit findings (H1, M1, M2, L2). Each
 * asserts a real bypass is now closed while legitimate queries still pass.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { DUCKDB_DIALECT, POSTGRES_DIALECT, MYSQL_DIALECT } from '../src/dialects.js';

const duck = (sql: string, policy = {}) => guardSql({ sql, dialect: DUCKDB_DIALECT, policy });
const pg = (sql: string, policy = {}) => guardSql({ sql, dialect: POSTGRES_DIALECT, policy });

describe('file/URL relations (DuckDB replacement scan) are blocked', () => {
  for (const sql of [
    "SELECT * FROM '/etc/passwd.csv'",
    "SELECT * FROM '/app/config/secrets.json'",
    "SELECT * FROM 'C:\\\\Windows\\\\win.ini'",
    "SELECT * FROM 'http://169.254.169.254/latest/meta-data/'",
    "SELECT * FROM 's3://bucket/private.parquet'",
    "SELECT * FROM '~/.ssh/id_rsa'",
    "SELECT * FROM 'data.csv' JOIN users ON true",
  ]) {
    it(`blocks: ${sql.slice(0, 46)}`, () => {
      expect(duck(sql).allowed).toBe(false);
      expect(pg(sql).allowed).toBe(false); // universal
    });
  }
  it('a registered table name (no path) is still allowed', () => {
    expect(duck('SELECT * FROM sales').allowed).toBe(true);
    expect(duck('SELECT region, count(*) FROM sales GROUP BY region').allowed).toBe(true);
  });
});

describe('parquet metadata readers are denied', () => {
  for (const fn of ['parquet_metadata', 'parquet_schema', 'parquet_file_metadata', 'parquet_kv_metadata']) {
    it(`blocks ${fn}()`, () => {
      expect(duck(`SELECT * FROM ${fn}('/x.parquet')`).allowed).toBe(false);
    });
  }
});

describe('auto-LIMIT survives a trailing line comment', () => {
  it('SQL ending in -- still gets an EFFECTIVE limit (on its own line)', () => {
    const v = pg('SELECT * FROM orders --', { maxRows: 100 });
    expect(v.allowed).toBe(true);
    expect(v.autoLimited).toBe(true);
    // The LIMIT must be on a line the trailing comment cannot swallow.
    expect(v.sql).toMatch(/\n\s*LIMIT 100/i);
    // And it must not be commented out.
    const lastLine = v.sql.split('\n').pop()!;
    expect(lastLine).toMatch(/LIMIT 100/i);
    expect(lastLine.trimStart().startsWith('--')).toBe(false);
  });
  it('MySQL # trailing comment likewise', () => {
    const v = guardSql({ sql: 'SELECT * FROM orders #', dialect: MYSQL_DIALECT, policy: { maxRows: 50 } });
    expect(v.allowed).toBe(true);
    expect(v.sql).toMatch(/\nLIMIT 50/i);
  });
});

describe('sequence mutations are denied', () => {
  it('nextval / setval blocked', () => {
    expect(pg("SELECT nextval('s')").allowed).toBe(false);
    expect(pg("SELECT setval('s', 1)").allowed).toBe(false);
    expect(duck("SELECT nextval('s')").allowed).toBe(false);
  });
});
