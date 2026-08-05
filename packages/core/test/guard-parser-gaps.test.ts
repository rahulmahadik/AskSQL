/**
 * The guard fails closed on any SQL its parser (node-sql-parser) cannot parse -
 * the security invariant. A few valid vendor constructs fall in that gap
 * (Postgres SUBSTRING(x FROM 'pat'), OVERLAY, GROUPING SETS). They are blocked
 * with `parse_failed` and an ACTIONABLE reason so the engine's repair loop can
 * recover by rephrasing to standard SQL. This test pins that contract.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { ORACLE_DIALECT, POSTGRES_DIALECT } from '../src/dialects.js';

const guard = (sql: string) => guardSql({ sql, dialect: POSTGRES_DIALECT });

describe('guard fails closed on parser gaps, recoverably', () => {
  const knownGaps = [
    "SELECT SUBSTRING(email FROM '@(.*)') AS d FROM shop.customers",
    "SELECT OVERLAY(name PLACING 'x' FROM 1) FROM t",
    'SELECT region, count(*) FROM t GROUP BY GROUPING SETS ((region), ())',
  ];

  it('blocks each known-unparseable construct with parse_failed', () => {
    for (const sql of knownGaps) {
      const v = guard(sql);
      expect(v.allowed, sql).toBe(false);
      expect(v.ruleId, sql).toBe('parse_failed');
    }
  });

  it('gives an actionable reason the repair loop can act on', () => {
    const v = guard(knownGaps[0]!);
    // Names the offending form and points at a parseable alternative.
    expect(v.reason).toMatch(/standard SQL/i);
    expect(v.reason).toMatch(/SUBSTRING|regexp_replace|split_part|function-call/i);
  });

  it('still allows the standard-SQL equivalents the repair would produce', () => {
    for (const sql of [
      "SELECT split_part(email, '@', 2) AS d FROM shop.customers",
      "SELECT regexp_replace(email, '.*@', '') AS d FROM shop.customers",
    ]) {
      expect(guard(sql).allowed, sql).toBe(true);
    }
  });
});

describe('Oracle FETCH FIRST (unparseable but valid - the model is told not to write it, yet sometimes does)', () => {
  const oracle = (sql: string, maxRows = 200) => guardSql({ sql, dialect: ORACLE_DIALECT, policy: { maxRows } });

  it('accepts a trailing FETCH FIRST and keeps the clause in place', () => {
    const v = oracle('SELECT region FROM sales ORDER BY amount DESC FETCH FIRST 1 ROWS ONLY');
    expect(v.allowed).toBe(true);
    // An inline-view wrap would make duplicate output column names an ORA-00918.
    expect(v.sql).not.toMatch(/^SELECT \* FROM \(/);
    expect(v.sql).toMatch(/FETCH\s+FIRST\s+1\s+ROWS\s+ONLY/i);
  });

  it('a duplicate output alias survives, as it does at top level in Oracle', () => {
    const v = oracle('SELECT region AS r, area AS r FROM sales FETCH FIRST 5 ROWS ONLY');
    expect(v.allowed).toBe(true);
    expect(v.sql).not.toMatch(/^SELECT \* FROM \(/);
  });

  it('accepts every legal spelling of the row-limiting clause', () => {
    for (const tail of [
      'FETCH NEXT 5 ROWS ONLY',
      'OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
      'FETCH FIRST ROW ONLY',
      'FETCH FIRST 10 PERCENT ROWS ONLY',
      'FETCH FIRST 5 ROWS WITH TIES',
    ]) {
      expect(oracle(`SELECT region FROM sales ${tail}`).allowed, tail).toBe(true);
    }
  });

  it('accepts the singular ROW form too', () => {
    expect(oracle('SELECT region FROM sales FETCH FIRST 5 ROW ONLY').allowed).toBe(true);
  });

  it('caps an over-limit FETCH FIRST at maxRows and reports the lowering', () => {
    const v = oracle('SELECT region FROM sales FETCH FIRST 500 ROWS ONLY', 200);
    expect(v.allowed).toBe(true);
    expect(v.sql).toMatch(/FETCH\s+FIRST\s+200\s+ROWS\s+ONLY/i);
    expect(v.loweredLimit).toBe(true);
  });

  it('still validates what is under the clause - a write does not sneak through', () => {
    const v = oracle('DELETE FROM sales FETCH FIRST 1 ROWS ONLY');
    expect(v.allowed).toBe(false);
  });

  it('a mid-query FETCH FIRST still fails closed rather than being mangled', () => {
    const v = oracle('SELECT * FROM (SELECT region FROM sales FETCH FIRST 3 ROWS ONLY) sub');
    expect(v.allowed).toBe(false);
  });
});
