/**
 * Dangerous package prefixes must be refused on every dialect, not only their
 * native one, so a mis-set dialect can never let an Oracle UTL_FILE call or a
 * Postgres pg_read_file slip through. Mirrors the cross-dialect guarantee the
 * function-name denylist already gives.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { POSTGRES_DIALECT, MYSQL_DIALECT, SQLITE_DIALECT, ORACLE_DIALECT, DUCKDB_DIALECT } from '../src/dialects.js';

const DIALECTS = [POSTGRES_DIALECT, MYSQL_DIALECT, SQLITE_DIALECT, ORACLE_DIALECT, DUCKDB_DIALECT];

describe('dangerous prefixes are blocked on every dialect', () => {
  const vectors = [
    "SELECT UTL_FILE.FOPEN('D', 'f', 'w') FROM t",
    "SELECT UTL_HTTP.REQUEST('http://evil') FROM t",
    'SELECT DBMS_SCHEDULER.CREATE_JOB() FROM t',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_ls_dir('/')",
  ];
  for (const sql of vectors) {
    for (const dialect of DIALECTS) {
      it(`${dialect.engine}: ${sql.slice(0, 34)}`, () => {
        expect(guardSql({ sql, dialect }).allowed).toBe(false);
      });
    }
  }
});

describe('legitimate reads are unaffected by the cross-dialect prefixes', () => {
  const ok = ['SELECT read_count FROM t', 'SELECT scan_id, pg_size FROM t', 'SELECT COUNT(*) FROM utl_readings'];
  for (const sql of ok) {
    for (const dialect of DIALECTS) {
      it(`${dialect.engine}: ${sql.slice(0, 34)}`, () => {
        expect(guardSql({ sql, dialect }).allowed).toBe(true);
      });
    }
  }
});
