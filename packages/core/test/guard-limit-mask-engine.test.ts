/**
 * Regression: lowerLimitInText must mask string/comment spans using the statement's engine.
 *
 * On MySQL a backslash escapes a quote inside a plain literal (`'\''` is a one-character string).
 * When the mask was computed without the engine, the scanner treated `\'` as an ordinary
 * character, closed the literal early (or ran it to EOF), and mislocated the binding LIMIT. The
 * model's oversized LIMIT was then left untouched in the executed SQL, so the database
 * materialized - and the driver buffered - every row before the post-fetch slice, defeating the
 * row cap's resource bound.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { MYSQL_DIALECT } from '../src/dialects.js';

describe('lowerLimitInText masks with the engine (MySQL backslash escapes)', () => {
  it('lowers the binding LIMIT even when a preceding literal contains an escaped quote', () => {
    const v = guardSql({
      sql: "SELECT '\\'' AS a, 88888 AS b FROM t LIMIT 5000",
      dialect: MYSQL_DIALECT,
      policy: { maxRows: 1000 },
    });
    expect(v.allowed).toBe(true);
    expect(v.loweredLimit).toBe(true);
    expect(v.sql).toContain('LIMIT 1000');
    expect(v.sql).not.toContain('LIMIT 5000');
    // The literal itself must be left byte-for-byte intact.
    expect(v.sql).toContain("'\\''");
  });

  it('still lowers a plain oversized LIMIT', () => {
    const v = guardSql({
      sql: "SELECT 'x' AS a FROM t LIMIT 5000",
      dialect: MYSQL_DIALECT,
      policy: { maxRows: 1000 },
    });
    expect(v.allowed).toBe(true);
    expect(v.loweredLimit).toBe(true);
    expect(v.sql).toContain('LIMIT 1000');
  });

  it('does not rewrite a digit run that lives inside a MySQL literal', () => {
    // The "9999" is data inside the escaped-quote string; only the trailing LIMIT is a real limit.
    const v = guardSql({
      sql: "SELECT '\\' 9999' AS note FROM t LIMIT 5000",
      dialect: MYSQL_DIALECT,
      policy: { maxRows: 1000 },
    });
    if (v.allowed) {
      expect(v.sql).toContain("'\\' 9999'");
      expect(v.sql).not.toContain('LIMIT 5000');
    }
  });
});
