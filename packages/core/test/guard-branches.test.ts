/**
 * Guard branch coverage: MySQL SHOW/DESCRIBE introspection forms, aggregate +
 * schema-qualified function extraction, custom deny-function policy, and the
 * allowFileFunctions escape hatch.
 */
import { describe, expect, it } from 'vitest';
import { guardSql, resolveGuardPolicy } from '../src/guard.js';
import { MYSQL_DIALECT, POSTGRES_DIALECT, DUCKDB_DIALECT } from '../src/dialects.js';

const my = (sql: string) => guardSql({ sql, dialect: MYSQL_DIALECT });

describe('MySQL SHOW / DESCRIBE introspection is allowed', () => {
  for (const sql of [
    'SHOW TABLES',
    'SHOW FULL COLUMNS FROM users',
    'SHOW CREATE TABLE users',
    'SHOW INDEX FROM users',
    'SHOW TRIGGERS',
    'DESCRIBE users',
    'DESC users',
  ]) {
    it(`allows: ${sql}`, () => expect(my(sql).allowed).toBe(true));
  }
  it('blocks a non-introspection SHOW form', () => {
    expect(my('SHOW GRANTS FOR root').allowed).toBe(false);
  });
});

describe('function extraction', () => {
  it('allows a plain aggregate', () =>
    expect(guardSql({ sql: 'SELECT COUNT(*) FROM t', dialect: POSTGRES_DIALECT }).allowed).toBe(true));
  it('blocks a schema-qualified dangerous package (Oracle prefix, any dialect)', () => {
    expect(guardSql({ sql: "SELECT UTL_HTTP.REQUEST('x') FROM t", dialect: POSTGRES_DIALECT }).allowed).toBe(false);
  });
});

describe('custom deny-function policy', () => {
  it('blocks a caller-denied function name', () => {
    const policy = resolveGuardPolicy({ denyFunctions: ['sketchy_udf'] });
    expect(guardSql({ sql: 'SELECT sketchy_udf(id) FROM t', dialect: POSTGRES_DIALECT, policy }).allowed).toBe(false);
    // a different function is still fine
    expect(guardSql({ sql: 'SELECT lower(name) FROM t', dialect: POSTGRES_DIALECT, policy }).allowed).toBe(true);
  });
});

describe('allowFileFunctions escape hatch', () => {
  it('blocks a DuckDB file reader by default but allows it when opted in', () => {
    expect(guardSql({ sql: "SELECT * FROM read_csv('a.csv')", dialect: DUCKDB_DIALECT }).allowed).toBe(false);
    const policy = resolveGuardPolicy({ allowFileFunctions: true });
    expect(guardSql({ sql: "SELECT * FROM read_csv('a.csv')", dialect: DUCKDB_DIALECT, policy }).allowed).toBe(true);
  });
});
