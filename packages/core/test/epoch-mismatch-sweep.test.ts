/**
 * A numeric column compared against a date answers zero against text, or the whole table against epoch
 * seconds, and never errors. Measured on a Room fixture: 7B returned 0 where the truth was 2, 30B
 * returned 5. Sweeps the cross product of column type, date expression, operator, shape and dialect,
 * because firing on a TEXT column would refuse correct SQL.
 */
import { describe, expect, it } from 'vitest';
import { epochUnitMismatch } from '../src/semantics.js';
import { DUCKDB_DIALECT, MYSQL_DIALECT, ORACLE_DIALECT, POSTGRES_DIALECT, SQLITE_DIALECT } from '../src/dialects.js';
import type { DialectInfo } from '../src/types.js';

/** Types that hold a number, so a date on the other side cannot mean the same thing. */
const NUMERIC_TYPES = ['INTEGER', 'INT', 'int', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'INT8', 'NUMERIC'];
/** Types that hold a date or text, where comparing against a date is exactly right. */
const DATE_SAFE_TYPES = ['TEXT', 'VARCHAR(32)', 'DATE', 'TIMESTAMP', 'DATETIME', 'REAL', 'BLOB', 'BOOLEAN'];

/** Expressions that produce a date or an instant. */
const DATE_EXPRESSIONS = [
  "date('now')",
  "date('now','-7 days')",
  "datetime('now')",
  "strftime('%s','now')",
  "strftime('%Y-%m-%d','now')",
  "julianday('now')",
  'CURRENT_DATE',
  'CURRENT_TIMESTAMP',
  "'2026-08-09'",
  "'2026-08-09 12:30:00'",
];
/** Right-hand sides that are legitimately numeric, or not a date at all. */
const SAFE_EXPRESSIONS = [
  '1755300000000',
  '0',
  "(strftime('%s','now') - 7*86400) * 1000",
  "(strftime('%s','now') - 7*86400)",
  'other_number',
  "'not-a-date'",
  "'2026'",
];

const OPERATORS = ['>=', '>', '<', '<=', '=', '<>'];

/** Query shapes the same comparison can hide in. */
const SHAPES: readonly ((lhs: string, op: string, rhs: string) => string)[] = [
  (l, o, r) => `SELECT * FROM events WHERE ${l} ${o} ${r}`,
  (l, o, r) => `SELECT * FROM events e WHERE e.${l} ${o} ${r}`,
  (l, o, r) => `SELECT * FROM events WHERE ${r} ${o} ${l}`,
  (l, o, r) => `SELECT * FROM events WHERE label = 'x' AND ${l} ${o} ${r}`,
  (l, o, r) => `SELECT * FROM events WHERE label = 'x' OR ${l} ${o} ${r}`,
  (l, o, r) => `SELECT COUNT(*) FROM events WHERE ${l} ${o} ${r}`,
  (l, o, r) => `SELECT label, COUNT(*) FROM events WHERE ${l} ${o} ${r} GROUP BY label`,
  (l, o, r) => `SELECT * FROM events JOIN people ON people.id = events.person_id WHERE ${l} ${o} ${r}`,
];

const DIALECTS: [string, DialectInfo][] = [
  ['postgres', POSTGRES_DIALECT],
  ['mysql', MYSQL_DIALECT],
  ['sqlite', SQLITE_DIALECT],
  ['duckdb', DUCKDB_DIALECT],
  ['oracle', ORACLE_DIALECT],
];

const catalogWith = (dbType: string) => ({
  tables: [
    {
      name: 'events',
      columns: [
        { name: 'happened_at', dbType },
        { name: 'other_number', dbType: 'INTEGER' },
        { name: 'label', dbType: 'TEXT' },
        { name: 'person_id', dbType: 'INTEGER' },
      ],
    },
    { name: 'people', columns: [{ name: 'id', dbType: 'INTEGER' }] },
  ],
});

describe('a numeric column compared against a date is always caught', () => {
  for (const [dialectName, dialect] of DIALECTS) {
    for (const dbType of NUMERIC_TYPES) {
      it(`${dialectName}/${dbType}: every date expression, operator and shape is flagged`, () => {
        const catalog = catalogWith(dbType);
        const missed: string[] = [];
        let checked = 0;
        for (const expr of DATE_EXPRESSIONS) {
          for (const op of OPERATORS) {
            for (const shape of SHAPES) {
              const sql = shape('happened_at', op, expr);
              checked++;
              if (epochUnitMismatch(sql, dialect.grammar, catalog) === null) missed.push(sql);
            }
          }
        }
        expect(checked).toBe(DATE_EXPRESSIONS.length * OPERATORS.length * SHAPES.length);
        expect(missed, `${missed.length} of ${checked} not flagged, e.g. ${missed[0]}`).toEqual([]);
      });
    }
  }
});

describe('a column that legitimately holds a date is never flagged', () => {
  for (const [dialectName, dialect] of DIALECTS) {
    for (const dbType of DATE_SAFE_TYPES) {
      it(`${dialectName}/${dbType}: comparing it with a date stays quiet`, () => {
        const catalog = catalogWith(dbType);
        const wrong: string[] = [];
        for (const expr of DATE_EXPRESSIONS) {
          for (const op of OPERATORS) {
            for (const shape of SHAPES) {
              const sql = shape('happened_at', op, expr);
              if (epochUnitMismatch(sql, dialect.grammar, catalog) !== null) wrong.push(sql);
            }
          }
        }
        expect(wrong, `${wrong.length} correct queries refused, e.g. ${wrong[0]}`).toEqual([]);
      });
    }
  }
});

describe('a numeric column compared numerically is never flagged', () => {
  for (const [dialectName, dialect] of DIALECTS) {
    for (const dbType of NUMERIC_TYPES) {
      it(`${dialectName}/${dbType}: a numeric bound is the right way to write it`, () => {
        const catalog = catalogWith(dbType);
        const wrong: string[] = [];
        for (const expr of SAFE_EXPRESSIONS) {
          for (const op of OPERATORS) {
            for (const shape of SHAPES) {
              const sql = shape('happened_at', op, expr);
              if (epochUnitMismatch(sql, dialect.grammar, catalog) !== null) wrong.push(sql);
            }
          }
        }
        expect(wrong, `${wrong.length} correct queries refused, e.g. ${wrong[0]}`).toEqual([]);
      });
    }
  }
});

describe('the shapes that must never be judged at all', () => {
  const catalog = catalogWith('INTEGER');
  const g = SQLITE_DIALECT.grammar;

  it('a date expression in the SELECT list is not a comparison', () => {
    expect(epochUnitMismatch("SELECT date('now') AS today, happened_at FROM events", g, catalog)).toBeNull();
  });

  it('a column the catalog does not know is left alone', () => {
    expect(epochUnitMismatch("SELECT * FROM events WHERE unknown_col >= date('now')", g, catalog)).toBeNull();
  });

  it('a name two tables type differently is not attributable', () => {
    const ambiguous = {
      tables: [
        { name: 'events', columns: [{ name: 'happened_at', dbType: 'INTEGER' }] },
        { name: 'logs', columns: [{ name: 'happened_at', dbType: 'TEXT' }] },
      ],
    };
    expect(epochUnitMismatch("SELECT * FROM events WHERE happened_at >= date('now')", g, ambiguous)).toBeNull();
  });

  it('unparsable SQL fails open rather than blocking', () => {
    expect(epochUnitMismatch('SELECT FROM WHERE', g, catalog)).toBeNull();
  });

  it('IS NULL on a numeric column is not a date comparison', () => {
    expect(epochUnitMismatch('SELECT * FROM events WHERE happened_at IS NOT NULL', g, catalog)).toBeNull();
  });
});
