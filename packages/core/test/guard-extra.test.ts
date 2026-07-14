/**
 * Additional corpus coverage: set-operations, nested CTE writes,
 * scalar-subquery writes, EXPLAIN variants, comment-only, and the
 * lexical belt for shapes the AST may normalize away.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { POSTGRES_DIALECT, MYSQL_DIALECT, SQLITE_DIALECT } from '../src/dialects.js';

const pg = (sql: string, policy = {}) => guardSql({ sql, dialect: POSTGRES_DIALECT, policy });

describe('set-operations', () => {
  it('UNION of two SELECTs allowed, LIMIT binds to the whole', () => {
    const v = pg('SELECT id FROM a UNION SELECT id FROM b', { maxRows: 10 });
    expect(v.allowed).toBe(true);
    expect(v.sql).toMatch(/LIMIT 10\s*$/);
  });
  it('UNION where one branch is a write is blocked', () => {
    // Not valid SQL in most grammars; must fail closed regardless.
    expect(pg('SELECT id FROM a UNION DELETE FROM b').allowed).toBe(false);
  });
});

describe('nested write in subquery', () => {
  it('write inside a scalar subquery blocked', () => {
    expect(pg('SELECT (DELETE FROM t RETURNING id) FROM other').allowed).toBe(false);
  });
  it('write inside a FROM subquery blocked', () => {
    expect(pg('SELECT * FROM (UPDATE t SET x=1 RETURNING *) s').allowed).toBe(false);
  });
  it('nested CTE write two levels deep blocked', () => {
    expect(pg('WITH a AS (SELECT 1), b AS (DELETE FROM t RETURNING *) SELECT * FROM a, b').allowed).toBe(false);
  });
});

describe('EXPLAIN variants', () => {
  it('EXPLAIN (FORMAT JSON) SELECT allowed', () => {
    expect(pg('EXPLAIN (FORMAT JSON) SELECT * FROM users').allowed).toBe(true);
  });
  it('EXPLAIN QUERY PLAN SELECT allowed (sqlite)', () => {
    expect(guardSql({ sql: 'EXPLAIN QUERY PLAN SELECT * FROM t', dialect: SQLITE_DIALECT }).allowed).toBe(true);
  });
  it('EXPLAIN INSERT blocked', () => {
    expect(pg('EXPLAIN INSERT INTO t VALUES (1)').allowed).toBe(false);
  });
});

describe('comment-only / empty-ish', () => {
  it('comment-only statement blocked (no statement)', () => {
    expect(pg('-- just a comment').allowed).toBe(false);
  });
  it('block-comment-only blocked', () => {
    expect(pg('/* nothing here */').allowed).toBe(false);
  });
});

describe('MySQL specifics', () => {
  const my = (sql: string) => guardSql({ sql, dialect: MYSQL_DIALECT });
  it('SHOW TABLES allowed', () => expect(my('SHOW TABLES').allowed).toBe(true));
  it('SHOW CREATE TABLE allowed', () => expect(my('SHOW CREATE TABLE users').allowed).toBe(true));
  it('SET blocked', () => expect(my('SET @x = 1').allowed).toBe(false));
  it('LOAD DATA INFILE blocked', () => expect(my("LOAD DATA INFILE '/etc/passwd' INTO TABLE t").allowed).toBe(false));
  it('HANDLER read blocked (not a plain SELECT)', () => expect(my('HANDLER t OPEN').allowed).toBe(false));
});

describe('whitespace/case robustness', () => {
  it('lowercase select allowed', () => expect(pg('select 1').allowed).toBe(true));
  it('leading whitespace + newlines allowed', () => expect(pg('\n\n   SELECT 1\n').allowed).toBe(true));
  it('mixed-case DeLeTe blocked', () => expect(pg('DeLeTe FROM users').allowed).toBe(false));
});

describe('auto-limit edge cases', () => {
  it('existing LIMIT with OFFSET preserved when under cap', () => {
    const v = pg('SELECT * FROM t LIMIT 5 OFFSET 20', { maxRows: 100 });
    expect(v.allowed).toBe(true);
    expect(v.autoLimited).toBe(false);
    expect(v.sql).toMatch(/OFFSET 20/i);
  });
  it('aggregate without LIMIT still gets a cap appended (harmless)', () => {
    const v = pg('SELECT count(*) FROM t', { maxRows: 100 });
    expect(v.sql).toMatch(/LIMIT 100/);
  });
});
