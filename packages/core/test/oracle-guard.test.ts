import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { ORACLE_DIALECT } from '../src/dialects.js';

const guard = (sql: string) => guardSql({ sql, dialect: ORACLE_DIALECT });

describe('Oracle guard', () => {
  it('allows a plain read-only SELECT (incl. FROM DUAL)', () => {
    expect(guard('SELECT 1 FROM DUAL').allowed).toBe(true);
    expect(guard('SELECT ename, sal FROM emp WHERE deptno = 10 ORDER BY sal DESC').allowed).toBe(true);
  });

  it('does NOT inject a LIMIT (driver caps rows for Oracle)', () => {
    const v = guard('SELECT ename FROM emp ORDER BY sal DESC');
    expect(v.allowed).toBe(true);
    expect(v.sql).not.toMatch(/limit/i);
    expect(v.autoLimited).toBe(false);
  });

  it('blocks SSRF URL-type constructors', () => {
    for (const fn of ['HTTPURITYPE', 'DBURITYPE', 'XDBURITYPE']) {
      const v = guard(`SELECT ${fn}('http://169.254.169.254/').getclob() FROM DUAL`);
      expect(v.allowed, fn).toBe(false);
    }
  });

  it('blocks dangerous package calls by prefix, schema-qualified or not', () => {
    for (const call of [
      "UTL_HTTP.REQUEST('http://evil')",
      "SYS.UTL_HTTP.REQUEST('http://evil')",
      "UTL_FILE.FOPEN('/etc','passwd','r')",
      'UTL_INADDR.GET_HOST_ADDRESS()',
      'DBMS_LOB.GETLENGTH(col)',
      'DBMS_METADATA.GET_DDL()',
    ]) {
      const v = guard(`SELECT ${call} FROM DUAL`);
      expect(v.allowed, call).toBe(false);
    }
  });

  it('blocks sequence pseudo-columns (a write)', () => {
    expect(guard('SELECT s.NEXTVAL FROM DUAL').allowed).toBe(false);
    expect(guard('SELECT my_seq.CURRVAL FROM DUAL').allowed).toBe(false);
  });

  it('still allows an ordinary column that merely resembles a package name', () => {
    // A column literally named "request" is fine; only qualified package prefixes are denied.
    expect(guard('SELECT request FROM tickets').allowed).toBe(true);
  });

  // Oracle has no LIMIT. Left to the database it is ORA-03049 after the repair loop has finished,
  // so it is refused here where the repair loop can still rewrite it.
  it('refuses a LIMIT clause, which Oracle cannot parse', () => {
    for (const sql of [
      'SELECT * FROM emp LIMIT 100',
      'SELECT ename FROM emp ORDER BY ename LIMIT 10 OFFSET 5',
      'select * from emp limit 5;',
    ]) {
      const verdict = guard(sql);
      expect(verdict.allowed, sql).toBe(false);
      expect(verdict.ruleId, sql).toBe('limit_unsupported');
    }
  });

  it('leaves the row-limiting Oracle does support alone', () => {
    expect(guard('SELECT * FROM emp FETCH FIRST 10 ROWS ONLY').allowed).toBe(true);
    expect(guard('SELECT * FROM emp ORDER BY empno').allowed).toBe(true);
    // "limit" inside a string is a value, not a clause.
    expect(guard("SELECT * FROM emp WHERE note = 'limit 5'").allowed).toBe(true);
  });

  it('blocks writes and DDL like every other dialect', () => {
    expect(guard('UPDATE emp SET sal = 0').allowed).toBe(false);
    expect(guard('DELETE FROM emp').allowed).toBe(false);
    expect(guard('DROP TABLE emp').allowed).toBe(false);
  });
});
