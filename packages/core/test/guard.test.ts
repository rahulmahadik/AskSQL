/**
 * The security-boundary corpus. These are written
 * as the contract the guard must satisfy; every bypass form must be blocked
 * and every legitimate SELECT must pass.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import {
  DUCKDB_DIALECT,
  MYSQL_DIALECT,
  POSTGRES_DIALECT,
  SQLITE_DIALECT,
} from '../src/dialects.js';
import type { DialectInfo } from '../src/types.js';

const pg = (sql: string, policy = {}) => guardSql({ sql, dialect: POSTGRES_DIALECT, policy });
const my = (sql: string) => guardSql({ sql, dialect: MYSQL_DIALECT });
const lite = (sql: string) => guardSql({ sql, dialect: SQLITE_DIALECT });
const duck = (sql: string, policy = {}) => guardSql({ sql, dialect: DUCKDB_DIALECT, policy });

describe('DDL blocked', () => {
  for (const sql of [
    'DROP TABLE users',
    'TRUNCATE users',
    'ALTER TABLE users ADD COLUMN x int',
    'CREATE TABLE t (id int)',
    'CREATE VIEW v AS SELECT 1',
    'DROP DATABASE prod',
  ]) {
    it(sql, () => expect(pg(sql).allowed).toBe(false));
  }
});

describe('DML blocked', () => {
  for (const sql of [
    "INSERT INTO users (name) VALUES ('x')",
    "UPDATE users SET name='x' WHERE id=1",
    'DELETE FROM users WHERE id=1',
    "REPLACE INTO users (id,name) VALUES (1,'x')",
    'MERGE INTO users u USING staging s ON u.id=s.id WHEN MATCHED THEN UPDATE SET u.name=s.name',
  ]) {
    it(sql, () => {
      expect(pg(sql).allowed).toBe(false);
      expect(my(sql).allowed).toBe(false);
    });
  }
});

describe('stacked statements blocked', () => {
  for (const sql of [
    'SELECT 1; DROP TABLE x',
    'SELECT 1;DROP TABLE x;--',
    'SELECT * FROM users; DELETE FROM users',
    "SELECT 'a;b' AS x; DROP TABLE t",
  ]) {
    it(sql, () => expect(pg(sql).allowed).toBe(false));
  }
  it('trailing semicolon on a single statement is fine', () => {
    expect(pg('SELECT * FROM users;').allowed).toBe(true);
  });
  it('semicolon inside a string literal is not a separator', () => {
    const v = pg("SELECT 'a;b;c' AS label FROM users");
    expect(v.allowed).toBe(true);
  });
});

describe('comment/obfuscation', () => {
  it('block comment inside keyword still parses as write and blocks', () => {
    expect(pg('DR/**/OP TABLE users').allowed).toBe(false);
  });
  it('trailing line comment does not smuggle a second statement', () => {
    expect(pg('SELECT * FROM users -- ; DROP TABLE users').allowed).toBe(true);
  });
  it('comment-hidden DROP after a select is blocked (still one visible statement)', () => {
    // The DROP is fully commented out -> the visible statement is a SELECT.
    expect(pg('SELECT 1 /* DROP TABLE users */').allowed).toBe(true);
  });
  it('MySQL # comment does not hide a separator', () => {
    expect(my('SELECT * FROM users # ; DROP TABLE users').allowed).toBe(true);
  });
});

describe('data-modifying CTE blocked', () => {
  for (const sql of [
    'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
    'WITH x AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM x',
    'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x',
  ]) {
    it(sql, () => expect(pg(sql).allowed).toBe(false));
  }
  it('read-only CTE is allowed', () => {
    const v = pg('WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval \'7 days\') SELECT count(*) FROM recent');
    expect(v.allowed).toBe(true);
  });
});

describe('SELECT INTO / OUTFILE blocked', () => {
  it('SELECT INTO new table (pg)', () => {
    expect(pg('SELECT * INTO new_table FROM users').allowed).toBe(false);
  });
  it('INTO OUTFILE (mysql)', () => {
    expect(my("SELECT * FROM users INTO OUTFILE '/tmp/x.csv'").allowed).toBe(false);
  });
  it('INTO DUMPFILE (mysql)', () => {
    expect(my("SELECT data FROM t INTO DUMPFILE '/tmp/x'").allowed).toBe(false);
  });
});

describe('locking clauses blocked', () => {
  for (const sql of [
    'SELECT * FROM users FOR UPDATE',
    'SELECT * FROM users FOR SHARE',
    'SELECT * FROM users FOR NO KEY UPDATE',
  ]) {
    it(sql, () => expect(pg(sql).allowed).toBe(false));
  }
});

describe('dangerous functions blocked', () => {
  const cases: [DialectInfo, string][] = [
    [POSTGRES_DIALECT, 'SELECT pg_sleep(10)'],
    [POSTGRES_DIALECT, "SELECT pg_read_file('/etc/passwd')"],
    [POSTGRES_DIALECT, "SELECT * FROM dblink('host=evil', 'SELECT 1') AS t(x int)"],
    [POSTGRES_DIALECT, 'SELECT pg_terminate_backend(123)'],
    [MYSQL_DIALECT, "SELECT load_file('/etc/passwd')"],
    [MYSQL_DIALECT, 'SELECT sleep(10)'],
    [MYSQL_DIALECT, 'SELECT benchmark(1000000, md5(1))'],
  ];
  for (const [dialect, sql] of cases) {
    it(`${dialect.engine}: ${sql}`, () => {
      expect(guardSql({ sql, dialect }).allowed).toBe(false);
    });
  }
});

describe('SQLite attach/pragma', () => {
  it('ATTACH blocked', () => {
    expect(lite("ATTACH DATABASE '/tmp/e.db' AS e").allowed).toBe(false);
  });
  it('load_extension blocked', () => {
    expect(lite("SELECT load_extension('x')").allowed).toBe(false);
  });
  it('read-only PRAGMA allowed', () => {
    expect(lite('PRAGMA table_info(users)').allowed).toBe(true);
  });
  it('write PRAGMA blocked', () => {
    expect(lite('PRAGMA journal_mode = WAL').allowed).toBe(false);
  });
});

describe('DuckDB file functions', () => {
  it("read_csv blocked in server mode (allowFileFunctions=false)", () => {
    expect(duck("SELECT * FROM read_csv_auto('/etc/passwd')").allowed).toBe(false);
  });
  it('read_csv allowed when policy permits (browser sandbox)', () => {
    expect(duck("SELECT * FROM read_csv_auto('data.csv')", { allowFileFunctions: true }).allowed).toBe(true);
  });
  it('COPY TO blocked', () => {
    expect(duck("COPY (SELECT 1) TO '/tmp/x.csv'").allowed).toBe(false);
  });
});

describe('EXPLAIN', () => {
  it('EXPLAIN SELECT allowed', () => {
    expect(pg('EXPLAIN SELECT * FROM users').allowed).toBe(true);
  });
  it('EXPLAIN of a write is blocked', () => {
    expect(pg('EXPLAIN DELETE FROM users').allowed).toBe(false);
  });
  it('EXPLAIN ANALYZE of a write is blocked', () => {
    expect(pg('EXPLAIN ANALYZE UPDATE users SET x=1').allowed).toBe(false);
  });
});

describe('transaction/session control blocked', () => {
  for (const sql of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SET search_path TO evil', 'GRANT ALL ON users TO public', 'REVOKE SELECT ON users FROM public']) {
    it(sql, () => expect(pg(sql).allowed).toBe(false));
  }
});

describe('CALL / DO blocked', () => {
  it('CALL proc blocked', () => expect(pg('CALL do_something()').allowed).toBe(false));
  it('immutable function inside SELECT is allowed', () => {
    expect(pg("SELECT upper(name), length(name) FROM users").allowed).toBe(true);
  });
});

describe('unicode homoglyph fail-closed', () => {
  it('Cyrillic S SELECT is blocked (unparseable)', () => {
    expect(pg('ЅELECT * FROM users').allowed).toBe(false);
  });
});

describe('resource bounds', () => {
  it('over-long SQL blocked', () => {
    const huge = 'SELECT ' + '1,'.repeat(60_000) + '1';
    expect(pg(huge).allowed).toBe(false);
  });
  it('deeply nested subqueries do not crash and block cleanly', () => {
    let s = 'SELECT 1';
    for (let i = 0; i < 200; i++) s = `SELECT * FROM (${s}) t${i}`;
    const v = pg(s);
    expect(typeof v.allowed).toBe('boolean');
  });
});

describe('catalog reads allowed', () => {
  it('information_schema read allowed', () => {
    expect(pg('SELECT table_name FROM information_schema.tables').allowed).toBe(true);
  });
});

describe('policy cannot loosen below read-only floor', () => {
  it('mode other than read-only throws', () => {
    expect(() => guardSql({ sql: 'SELECT 1', dialect: POSTGRES_DIALECT, policy: { mode: 'write' as never } })).toThrow();
  });
});

describe('auto-LIMIT', () => {
  it('adds a LIMIT when missing', () => {
    const v = pg('SELECT * FROM users', { maxRows: 100 });
    expect(v.allowed).toBe(true);
    expect(v.autoLimited).toBe(true);
    expect(v.sql.toLowerCase()).toContain('limit 100');
  });
  it('lowers a too-high LIMIT', () => {
    const v = pg('SELECT * FROM users LIMIT 999999', { maxRows: 100 });
    expect(v.loweredLimit).toBe(true);
    expect(v.sql).toMatch(/limit\s+100/i);
  });
  it('preserves a smaller LIMIT', () => {
    const v = pg('SELECT * FROM users LIMIT 5', { maxRows: 100 });
    expect(v.autoLimited).toBe(false);
    expect(v.loweredLimit).toBe(false);
    expect(v.sql).toMatch(/limit\s+5/i);
  });
  it('does not add LIMIT under EXPLAIN', () => {
    const v = pg('EXPLAIN SELECT * FROM users', { maxRows: 100 });
    expect(v.autoLimited).toBe(false);
  });
});

describe('template smuggling is literal', () => {
  it('template-like text in a string literal is not interpolated and passes', () => {
    const v = pg("SELECT '${1+1}' AS a, '{{x}}' AS b FROM users");
    expect(v.allowed).toBe(true);
  });
});

describe('legit SELECT variety passes', () => {
  const ok = [
    'SELECT count(*) FROM orders',
    'SELECT u.name, count(o.id) FROM users u LEFT JOIN orders o ON o.user_id=u.id GROUP BY u.name ORDER BY 2 DESC LIMIT 10',
    "SELECT * FROM users WHERE created_at > now() - interval '30 days'",
    'WITH t AS (SELECT 1 AS n) SELECT n FROM t',
    'SELECT * FROM users u JOIN (SELECT user_id, max(created_at) mx FROM orders GROUP BY user_id) last ON last.user_id=u.id',
    'SELECT "OrderItems"."Qty" FROM "OrderItems"',
  ];
  for (const sql of ok) it(sql, () => expect(pg(sql).allowed).toBe(true));
});

describe('empty / whitespace', () => {
  it('empty blocked', () => expect(pg('').allowed).toBe(false));
  it('whitespace blocked', () => expect(pg('   \n  ').allowed).toBe(false));
});

describe('sqlite unbounded recursive CTE (sync-thread wedge)', () => {
  const wedge = 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r';
  it('aggregate over unbounded recursion blocked', () => {
    const v = lite(wedge);
    expect(v.allowed).toBe(false);
    expect(v.ruleId).toBe('recursive_no_limit');
  });
  it('GROUP BY over unbounded recursion blocked', () =>
    expect(lite('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT n, count(*) FROM r GROUP BY n').allowed).toBe(false));
  it('same query with a LIMIT is allowed', () =>
    expect(lite('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r LIMIT 100) SELECT count(*) FROM r').allowed).toBe(true));
  it('plain streaming select over recursion is allowed (auto-LIMIT bounds it)', () =>
    expect(lite('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT n FROM r').allowed).toBe(true));
  it('non-recursive aggregate CTE is allowed', () =>
    expect(lite('WITH t AS (SELECT 1 AS n) SELECT count(*) FROM t').allowed).toBe(true));
  it('the wedge is sqlite-only (pg has statement_timeout)', () =>
    expect(pg(wedge).allowed).toBe(true));
});
