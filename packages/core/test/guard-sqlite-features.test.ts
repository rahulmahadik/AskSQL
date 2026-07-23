/**
 * SQLite parses under the Postgresql grammar (node-sql-parser's Sqlite grammar is
 * outdated). This pins that valid modern SQLite features are allowed while writes
 * and SQLite-specific dangers stay blocked - proving the grammar switch did not
 * weaken the read-only floor.
 */
import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/guard.js';
import { SQLITE_DIALECT } from '../src/dialects.js';

const guard = (sql: string) => guardSql({ sql, dialect: SQLITE_DIALECT });

describe('SQLite: valid modern features are allowed', () => {
  const allowed = [
    'SELECT RANK() OVER (PARTITION BY region ORDER BY x DESC) FROM t',
    'SELECT LAG(x) OVER (ORDER BY id), LEAD(x) OVER (ORDER BY id) FROM t',
    'SELECT SUM(x) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t',
    'SELECT * FROM a RIGHT JOIN b ON a.id = b.id',
    'SELECT * FROM a FULL OUTER JOIN b ON a.id = b.id',
    'SELECT id FROM a INTERSECT SELECT id FROM b',
    'SELECT id FROM a EXCEPT SELECT id FROM b',
    'SELECT COUNT(*) FILTER (WHERE x > 0) FROM t',
    'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 3) SELECT * FROM r',
  ];
  for (const sql of allowed) it(sql.slice(0, 48), () => expect(guard(sql).allowed).toBe(true));
});

describe('SQLite: read-only floor and SQLite-specific dangers stay blocked', () => {
  const blocked = [
    'DELETE FROM t',
    'UPDATE t SET x = 1',
    'DROP TABLE t',
    'INSERT INTO t VALUES (1)',
    'SELECT 1; DROP TABLE t',
    "SELECT load_extension('evil')",
    "SELECT writefile('/tmp/x', 'data')",
    'PRAGMA writable_schema = ON',
  ];
  for (const sql of blocked) it(sql.slice(0, 40), () => expect(guard(sql).allowed).toBe(false));

  it('still allows read-only PRAGMA introspection', () => {
    expect(guard('PRAGMA table_info(t)').allowed).toBe(true);
  });
});
