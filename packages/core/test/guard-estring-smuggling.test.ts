/**
 * Regression: statement smuggling through a mis-detected E-string.
 *
 * The stripper treated ANY `e`/`E` followed by a quote as the start of a
 * PostgreSQL E'...' string, including the trailing E of `LIKE`, `ILIKE` and
 * `date`. Inside an E-string `\'` is an escaped quote, so the stripper ran past
 * the literal's real end and swallowed the `;` that followed - while Postgres,
 * with the default standard_conforming_strings=on, ended the string at `\'` and
 * happily read the rest as further statements.
 *
 * The two lexers disagreeing meant `hasMultipleStatements` saw one statement
 * where the server saw four. This was exploited end to end against a live
 * PostgreSQL: the guard returned allowed, and a smuggled `COMMIT; DROP TABLE`
 * ended the BEGIN READ ONLY transaction and destroyed the table.
 *
 * These cases must stay blocked. The E-string prefix is only real when the E
 * STARTS a token.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';

const pg = (sql: string) => guardSql({ sql, dialect: POSTGRES_DIALECT });

describe('E-string smuggling', () => {
  it.each([
    ['LIKE', `SELECT id FROM t WHERE name LIKE'x\\'; COMMIT; DROP TABLE t; SELECT 1 WHERE false --'`],
    ['ILIKE', `SELECT id FROM t WHERE name ILIKE'x\\'; DROP TABLE t; SELECT 1 WHERE false --'`],
    ['date', `SELECT id FROM t WHERE d > date'2024-01-01\\'; DROP TABLE t; SELECT 1 WHERE false --'`],
    ['uppercase LIKE', `SELECT id FROM t WHERE name LIKE'x\\'; delete from t; select 1 where false --'`],
  ])('%s immediately followed by a quote cannot smuggle a second statement', (_label, sql) => {
    const v = pg(sql);
    expect(v.allowed).toBe(false);
  });

  it('a real E-string still works and is not mistaken for smuggling', () => {
    // E starts the token here, so this genuinely is an E-string.
    const v = pg(`SELECT id FROM t WHERE name = E'line\\nbreak'`);
    expect(v.allowed).toBe(true);
  });

  it('a real E-string may still not carry a second statement', () => {
    const v = pg(`SELECT id FROM t WHERE name = E'x'; DROP TABLE t`);
    expect(v.allowed).toBe(false);
  });

  it('ordinary LIKE with a quoted pattern is unaffected', () => {
    const v = pg(`SELECT id FROM t WHERE name LIKE 'a%'`);
    expect(v.allowed).toBe(true);
  });
});

/**
 * The AST walk cannot see inside a string literal, so a function that takes SQL
 * as text executes whatever it is handed - bypassing every other deny entry.
 */
describe('query-as-string functions', () => {
  it.each([
    ["SELECT query_to_xml('SELECT pg_sleep(60)', true, true, '')"],
    ["SELECT query_to_xmlschema('SELECT 1', true, true, '')"],
    ["SELECT query_to_xml_and_xmlschema('SELECT 1', true, true, '')"],
    ["SELECT table_to_xml('t', true, true, '')"],
    ["SELECT cursor_to_xml('c', 1, true, true, '')"],
    ["SELECT schema_to_xml('public', true, true, '')"],
    ["SELECT database_to_xml(true, true, '')"],
  ])('%s is blocked', (sql) => {
    expect(pg(sql).allowed).toBe(false);
  });

  it('a bare denied function is still blocked (sanity)', () => {
    expect(pg('SELECT pg_sleep(60)').allowed).toBe(false);
  });
});
