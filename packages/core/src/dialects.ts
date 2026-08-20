/**
 * Built-in dialect descriptors. Connectors reference these; core never
 * branches on engine names - only on DialectInfo fields.
 */

import type { DialectInfo } from './types.js';

export const POSTGRES_DIALECT: DialectInfo = Object.freeze({
  engine: 'postgres',
  grammar: 'Postgresql',
  quoteChar: '"',
  promptLabel: 'PostgreSQL',
  limitStyle: 'limit',
  promptNotes: Object.freeze([
    'When a column comment names an epoch unit, build the bound in THAT SAME unit and no other. For ' +
      "'epoch seconds' compare against a seconds bound unchanged; for 'epoch milliseconds' multiply the " +
      'seconds bound by 1000. Mixing them raises no error: milliseconds against a seconds bound matches ' +
      'every row, and seconds against a milliseconds bound matches none.',
    'Quote mixed-case or reserved identifiers with double quotes.',
    'Use ILIKE for case-insensitive text matching.',
    "Combine values into one string with string_agg(col, ', ').",
    "Use date_trunc / interval arithmetic for date math (e.g. now - interval '30 days').",
  ]),
});

export const MYSQL_DIALECT: DialectInfo = Object.freeze({
  engine: 'mysql',
  grammar: 'MySQL',
  quoteChar: '`',
  promptLabel: 'MySQL',
  limitStyle: 'limit',
  promptNotes: Object.freeze([
    'When a column comment names an epoch unit, build the bound in THAT SAME unit and no other. For ' +
      "'epoch seconds' compare against a seconds bound unchanged; for 'epoch milliseconds' multiply the " +
      'seconds bound by 1000. Mixing them raises no error: milliseconds against a seconds bound matches ' +
      'every row, and seconds against a milliseconds bound matches none.',
    'Quote identifiers with backticks when needed.',
    'Use DATE_SUB / DATE_ADD / DATE_FORMAT for date math.',
    "Combine values into one string with GROUP_CONCAT(col SEPARATOR ', ').",
  ]),
});

export const SQLITE_DIALECT: DialectInfo = Object.freeze({
  engine: 'sqlite',
  // node-sql-parser's 'Sqlite' grammar rejects valid modern SQLite, so SQLite parses under 'Postgresql'.
  grammar: 'Postgresql',
  quoteChar: '"',
  promptLabel: 'SQLite',
  limitStyle: 'limit',
  promptNotes: Object.freeze([
    "Dates: a TEXT column holds ISO text, so compare it with date/datetime/strftime (e.g. date('now','-30 days')). " +
      'An INTEGER column holds a number - usually epoch seconds, or milliseconds if the values are ~1000x larger - ' +
      "so build the bound as a number in the SAME units, e.g. (strftime('%s','now') - 30*86400) * 1000 for " +
      'milliseconds. Never compare an INTEGER column with a text date: nothing matches and no error is raised.',
    'There are no schemas; refer to tables by bare name.',
    "Combine values into one string with group_concat(col, ', ').",
  ]),
});

export const ORACLE_DIALECT: DialectInfo = Object.freeze({
  engine: 'oracle',
  // node-sql-parser has no Oracle grammar; Postgresql parses Oracle read SELECTs.
  grammar: 'Postgresql',
  quoteChar: '"',
  promptLabel: 'Oracle',
  // The connector caps rows via the driver; the model must not write its own row limit.
  limitStyle: 'fetch',
  promptNotes: Object.freeze([
    'When a column comment names an epoch unit, build the bound in THAT SAME unit and no other. For ' +
      "'epoch seconds' compare against a seconds bound unchanged; for 'epoch milliseconds' multiply the " +
      'seconds bound by 1000. Mixing them raises no error: milliseconds against a seconds bound matches ' +
      'every row, and seconds against a milliseconds bound matches none.',
    'Do not add a row limit clause (no FETCH FIRST, no ROWNUM, no LIMIT). Order the results and the system returns the top rows.',
    'Use TO_DATE / TO_CHAR / SYSDATE and interval arithmetic for date math.',
    'Unquoted identifiers are case-insensitive and stored upper case; double-quote to preserve case.',
    'Select a literal from the DUAL table (e.g. SELECT 1 FROM DUAL), not a bare SELECT 1.',
    'There is no boolean type; a comparison is not a directly selectable value.',
    'The safety validator cannot read LISTAGG ... WITHIN GROUP, so return the rows themselves rather than combining them into one string.',
  ]),
});

export const DUCKDB_DIALECT: DialectInfo = Object.freeze({
  engine: 'duckdb',
  grammar: 'Postgresql',
  quoteChar: '"',
  promptLabel: 'DuckDB',
  limitStyle: 'limit',
  promptNotes: Object.freeze([
    'When a column comment names an epoch unit, build the bound in THAT SAME unit and no other. For ' +
      "'epoch seconds' compare against a seconds bound unchanged; for 'epoch milliseconds' multiply the " +
      'seconds bound by 1000. Mixing them raises no error: milliseconds against a seconds bound matches ' +
      'every row, and seconds against a milliseconds bound matches none.',
    'DuckDB follows PostgreSQL syntax for queries.',
    "Combine values into one string with string_agg(col, ', '); SEPARATOR is MySQL syntax and is rejected here.",
    'Uploaded files are already registered as tables - query them by table name, never by file path.',
  ]),
});

const BY_ENGINE: Readonly<Record<string, DialectInfo>> = Object.freeze({
  postgres: POSTGRES_DIALECT,
  mysql: MYSQL_DIALECT,
  sqlite: SQLITE_DIALECT,
  oracle: ORACLE_DIALECT,
  duckdb: DUCKDB_DIALECT,
});

/** The built-in descriptor for an engine, or undefined for one supplied by a third-party connector. */
export function dialectFor(engine: string): DialectInfo | undefined {
  return BY_ENGINE[engine];
}
