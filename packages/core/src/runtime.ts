/**
 * The parts of core a connector needs at runtime: the error type, the dialect table, and types.
 * Deliberately guard-free, so importing it does not pull the SQL parser (~2.5MB) into a bundle.
 */

export { AskSqlError, type AskSqlErrorOptions, type ErrorCode } from './errors.js';
export { DUCKDB_DIALECT, MYSQL_DIALECT, ORACLE_DIALECT, POSTGRES_DIALECT, SQLITE_DIALECT } from './dialects.js';
export { VALUE_SAMPLE_MAX_DISTINCT } from './types.js';
export type * from './types.js';
