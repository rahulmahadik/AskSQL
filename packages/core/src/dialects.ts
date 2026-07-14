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
  grammar: 'Sqlite',
  quoteChar: '"',
  promptLabel: 'SQLite',
  limitStyle: 'limit',
  promptNotes: Object.freeze([
      "Use date/datetime/strftime for date math (e.g. date('now','-30 days')).",
    'There are no schemas; refer to tables by bare name.',
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
