/**
 * SQLite parses under the Postgresql grammar, which has no MATCH, so every Room @Fts4 query was refused
 * as unparseable. Verified against a populated FTS4 table: MATCH returns the matching rows, and the
 * `= 'term'` form a prompt might steer to returns none. The statement that runs keeps MATCH verbatim.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { POSTGRES_DIALECT, SQLITE_DIALECT } from '../src/dialects.js';

const sqlite = (sql: string) => guardSql({ sql, dialect: SQLITE_DIALECT });

describe('a full-text query is allowed, and runs as written', () => {
  it('accepts MATCH against the table and against a column', () => {
    for (const sql of [
      "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'memory'",
      "SELECT body FROM messages_fts WHERE body MATCH 'memory'",
      "SELECT m.body FROM messages m JOIN messages_fts f ON f.rowid = m.id WHERE f.body MATCH 'rope memory'",
    ]) {
      const v = sqlite(sql);
      expect(v.allowed, `${sql} -> ${v.reason ?? ''}`).toBe(true);
      // The operator survives: rewritten to `=` it would silently return nothing on FTS4.
      expect(v.sql).toMatch(/\bMATCH\b/);
    }
  });

  it('keeps the search term exactly, spaces and quotes included', () => {
    const v = sqlite("SELECT rowid FROM t_fts WHERE t_fts MATCH 'rope memory'");
    expect(v.sql).toContain("MATCH 'rope memory'");
  });

  it('still applies the row cap to a full-text query', () => {
    const v = sqlite("SELECT body FROM messages_fts WHERE body MATCH 'a'");
    expect(v.autoLimited).toBe(true);
    expect(v.sql).toMatch(/LIMIT \d+/);
  });
});

describe('nothing else slips in behind MATCH', () => {
  const mustBlock: [string, string][] = [
    ['a write', "DELETE FROM messages WHERE body MATCH 'x'"],
    ['an update', "UPDATE messages SET body = 'x' WHERE body MATCH 'y'"],
    ['a stacked statement', "SELECT 1 FROM t WHERE a MATCH 'x'; DROP TABLE t"],
    ['an ATTACH after it', "SELECT 1 FROM t WHERE a MATCH 'x'; ATTACH DATABASE '/tmp/y.db' AS y"],
    ['a denied function', "SELECT load_extension('x') FROM t WHERE a MATCH 'y'"],
    ['a right side that is a column', 'SELECT * FROM t WHERE a MATCH b'],
    ['a right side that is a subquery', 'SELECT * FROM t WHERE a MATCH (SELECT x FROM y)'],
    ['a right side that is a parameter', 'SELECT * FROM t WHERE a MATCH ?'],
  ];
  for (const [label, sql] of mustBlock) {
    it(`refuses ${label}`, () => {
      expect(sqlite(sql).allowed, sql).toBe(false);
    });
  }

  it('leaves the word alone inside a string literal', () => {
    const v = sqlite("SELECT * FROM t WHERE note = 'a match here'");
    expect(v.allowed).toBe(true);
    expect(v.sql).toContain("'a match here'");
  });

  it('does not accept MATCH on an engine that has no such operator', () => {
    expect(guardSql({ sql: "SELECT * FROM t WHERE a MATCH 'x'", dialect: POSTGRES_DIALECT }).allowed).toBe(false);
  });
});
