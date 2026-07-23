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
    'Quote mixed-case or reserved identifiers with double quotes.',
    'Use ILIKE for case-insensitive text matching.',
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
    'Quote identifiers with backticks when needed.',
    'Use DATE_SUB / DATE_ADD / DATE_FORMAT for date math.',
  ]),
});

export const SQLITE_DIALECT: DialectInfo = Object.freeze({
  engine: 'sqlite',
  // node-sql-parser's 'Sqlite' grammar is outdated and rejects valid modern SQLite
  // (RIGHT/FULL JOIN, window functions, INTERSECT/EXCEPT, FILTER, all 3.25-3.39).
  // SQLite SELECT syntax is standard-SQL-compatible, so parse under 'Postgresql';
  // the sqlite-specific safety (PRAGMA allowlist, denylist, recursive wedge) keys
  // on `engine`, not the grammar, so it is unaffected.
  grammar: 'Postgresql',
  quoteChar: '"',
  promptLabel: 'SQLite',
  limitStyle: 'limit',
  promptNotes: Object.freeze([
    "Use date/datetime/strftime for date math (e.g. date('now','-30 days')).",
    'There are no schemas; refer to tables by bare name.',
  ]),
});

export const ORACLE_DIALECT: DialectInfo = Object.freeze({
  engine: 'oracle',
  // node-sql-parser has no Oracle grammar; Postgresql is the closest superset that
  // parses Oracle read SELECTs (function calls, "quoted" identifiers, ROWNUM).
  grammar: 'Postgresql',
  quoteChar: '"',
  promptLabel: 'Oracle',
  // The connector caps rows via the driver, not a SQL clause (the guard's parser
  // cannot validate FETCH FIRST); the model must not write its own row limit.
  limitStyle: 'fetch',
  promptNotes: Object.freeze([
    'Do not add a row limit clause (no FETCH FIRST, no ROWNUM, no LIMIT). Order the results and the system returns the top rows.',
    'Use TO_DATE / TO_CHAR / SYSDATE and interval arithmetic for date math.',
    'Unquoted identifiers are case-insensitive and stored upper case; double-quote to preserve case.',
    'Select a literal from the DUAL table (e.g. SELECT 1 FROM DUAL), not a bare SELECT 1.',
    'There is no boolean type; a comparison is not a directly selectable value.',
  ]),
});

export const DUCKDB_DIALECT: DialectInfo = Object.freeze({
  engine: 'duckdb',
  grammar: 'Postgresql',
  quoteChar: '"',
  promptLabel: 'DuckDB',
  limitStyle: 'limit',
  promptNotes: Object.freeze([
    'DuckDB follows PostgreSQL syntax for queries.',
    'Uploaded files are already registered as tables - query them by table name, never by file path.',
  ]),
});
