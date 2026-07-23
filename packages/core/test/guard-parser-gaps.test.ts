/**
 * The guard fails closed on any SQL its parser (node-sql-parser) cannot parse -
 * the security invariant. A few valid vendor constructs fall in that gap
 * (Postgres SUBSTRING(x FROM 'pat'), OVERLAY, GROUPING SETS). They are blocked
 * with `parse_failed` and an ACTIONABLE reason so the engine's repair loop can
 * recover by rephrasing to standard SQL. This test pins that contract.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';

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
