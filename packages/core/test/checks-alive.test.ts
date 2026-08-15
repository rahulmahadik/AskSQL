/**
 * Every catalog check fails open by design: it returns null on anything it cannot attribute, so a
 * parse it cannot read is indistinguishable from a clean query. That makes a check easy to disable
 * by accident and impossible to notice, which is exactly what happened. A top-N question on Oracle
 * gets `FETCH FIRST n ROWS ONLY` from the model, the parser these checks use cannot read that tail,
 * and every one of them went quiet: a query selecting a column no table had reached the database.
 *
 * These tests give every check a query it MUST flag, on every dialect, both guarded and carrying
 * the Oracle tail. A check that goes quiet fails here instead of in production.
 */
import { describe, expect, it } from 'vitest';
import { ambiguousColumn, firstUnknownColumn, firstUnknownTable } from '../src/engine.js';
import { fanOutAggregate, nestedAggregate, ungroupedAggregate } from '../src/semantics.js';
import { guardSql } from '../src/guard.js';
import { DUCKDB_DIALECT, MYSQL_DIALECT, ORACLE_DIALECT, POSTGRES_DIALECT, SQLITE_DIALECT } from '../src/dialects.js';
import type { DialectInfo, SchemaCatalog } from '../src/types.js';

const table = (name: string, columns: string[]) => ({
  name,
  kind: 'table' as const,
  columns: columns.map((c) => ({ name: c, dbType: 'text', nullable: true })),
  primaryKey: [],
  foreignKeys: [],
  uniques: [],
  checks: [],
  indexes: [],
  source: 'db' as const,
});

const catalog = {
  engine: 'postgres',
  schemas: [],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
  tables: [table('album', ['albumid', 'title', 'artistid']), table('artist', ['artistid', 'name'])],
} as unknown as SchemaCatalog;

/** A parent with a total and a child that multiplies its rows: the shape the fan-out floor is for. */
const fanOutCatalog = {
  tables: [
    {
      name: 'invoice',
      columns: [{ name: 'invoiceid' }, { name: 'total' }],
      primaryKey: ['invoiceid'],
      foreignKeys: [],
    },
    {
      name: 'invoiceline',
      columns: [{ name: 'invoicelineid' }, { name: 'invoiceid' }],
      primaryKey: ['invoicelineid'],
      foreignKeys: [{ columns: ['invoiceid'], refTable: 'invoice', refColumns: ['invoiceid'] }],
    },
  ],
} as unknown as SchemaCatalog;

const DIALECTS: [string, DialectInfo][] = [
  ['postgres', POSTGRES_DIALECT],
  ['mysql', MYSQL_DIALECT],
  ['sqlite', SQLITE_DIALECT],
  ['duckdb', DUCKDB_DIALECT],
  ['oracle', ORACLE_DIALECT],
];

/** The statement as the engine judges it: guarded, so each dialect's own row cap is in place. */
function guarded(sql: string, dialect: DialectInfo): string {
  const v = guardSql({ sql, dialect });
  expect(v.allowed, `${dialect.engine}: ${v.reason ?? ''}`).toBe(true);
  return v.sql;
}

describe('the column floor is alive on every dialect', () => {
  for (const [name, dialect] of DIALECTS) {
    it(`${name}: flags a column the aliased table does not have`, () => {
      const sql = guarded('SELECT a.name FROM album a', dialect);
      const found = firstUnknownColumn(sql, catalog, dialect.grammar);
      expect(found, `${name} judged: ${sql}`).not.toBeNull();
      expect(found!.column.toLowerCase()).toBe('name');
      // The catalog's own spelling, so the message matches the schema the model was given.
      expect(found!.table.toLowerCase()).toBe('album');
      expect(found!.available).toContain('title');
    });

    it(`${name}: flags a column no table in the query has`, () => {
      const sql = guarded('SELECT album.nosuchcol FROM album', dialect);
      expect(firstUnknownColumn(sql, catalog, dialect.grammar), name).not.toBeNull();
    });

    it(`${name}: leaves a real column alone`, () => {
      const sql = guarded('SELECT a.title FROM album a', dialect);
      expect(firstUnknownColumn(sql, catalog, dialect.grammar), name).toBeNull();
    });
  }
});

describe('the table floor is alive on every dialect', () => {
  for (const [name, dialect] of DIALECTS) {
    it(`${name}: flags a table the catalog does not have`, () => {
      const sql = guarded('SELECT * FROM nosuchtable', dialect);
      expect(firstUnknownTable(sql, catalog, dialect.grammar), name).not.toBeNull();
    });
  }
});

describe('the ambiguous-column floor is alive on every dialect', () => {
  for (const [name, dialect] of DIALECTS) {
    it(`${name}: flags a bare column both joined tables have`, () => {
      const sql = guarded('SELECT artistid FROM album JOIN artist ON album.artistid = artist.artistid', dialect);
      expect(ambiguousColumn(sql, catalog, dialect.grammar), name).toBe('artistid');
    });
  }
});

describe('an Oracle row-limit tail does not blind any check', () => {
  // The exact shape a top-N question produces, which is where every one of these went quiet.
  const TAILS = ['FETCH FIRST 50 ROWS ONLY', 'FETCH NEXT 1 ROWS ONLY', 'OFFSET 5 ROWS FETCH NEXT 50 ROWS ONLY'];
  const g = ORACLE_DIALECT.grammar;

  for (const tail of TAILS) {
    it(`the column floor still fires with "${tail}"`, () => {
      expect(firstUnknownColumn(`SELECT a.name FROM album a ORDER BY a.title ${tail}`, catalog, g)).not.toBeNull();
    });

    it(`the table floor still fires with "${tail}"`, () => {
      expect(firstUnknownTable(`SELECT * FROM nosuchtable ${tail}`, catalog, g)).not.toBeNull();
    });

    it(`the fan-out floor still fires with "${tail}"`, () => {
      const sql = `SELECT SUM(i.total) FROM invoice i JOIN invoiceline l ON i.invoiceid = l.invoiceid ${tail}`;
      expect(fanOutAggregate(sql, g, fanOutCatalog)).not.toBeNull();
    });

    it(`the ungrouped-aggregate lint still fires with "${tail}"`, () => {
      expect(ungroupedAggregate(`SELECT title, COUNT(*) FROM album ${tail}`, g)).not.toBeNull();
    });

    it(`the ambiguous-column floor still fires with "${tail}"`, () => {
      const sql = `SELECT artistid FROM album JOIN artist ON album.artistid = artist.artistid ${tail}`;
      expect(ambiguousColumn(sql, catalog, g)).toBe('artistid');
    });
  }

  it('the other dialects cap with LIMIT, which parses, and stay alive too', () => {
    for (const [name, dialect] of DIALECTS.filter(([n]) => n !== 'oracle')) {
      expect(firstUnknownColumn('SELECT a.name FROM album a LIMIT 50', catalog, dialect.grammar), name).not.toBeNull();
    }
  });
});

describe('the fan-out floor is alive on every dialect', () => {
  const sum = 'SELECT SUM(i.total) FROM invoice i JOIN invoiceline l ON i.invoiceid = l.invoiceid';
  for (const [name, dialect] of DIALECTS) {
    it(`${name}: a SUM multiplied by a one-to-many join is reported`, () => {
      const sql = guarded(sum, dialect);
      const found = fanOutAggregate(sql, dialect.grammar, fanOutCatalog);
      expect(found, `${name} judged: ${sql}`).not.toBeNull();
      expect(found!.parent).toBe('invoice');
      expect(found!.child).toBe('invoiceline');
    });
  }
});

describe('the aggregate lints are alive on every dialect', () => {
  for (const [name, dialect] of DIALECTS) {
    it(`${name}: an aggregate beside a bare column with no GROUP BY is reported`, () => {
      const sql = guarded('SELECT title, COUNT(*) FROM album', dialect);
      expect(ungroupedAggregate(sql, dialect.grammar), `${name}: ${sql}`).not.toBeNull();
    });

    it(`${name}: an aggregate inside an aggregate is reported`, () => {
      const sql = guarded('SELECT SUM(COUNT(albumid)) FROM album GROUP BY title', dialect);
      expect(nestedAggregate(sql, dialect.grammar), `${name}: ${sql}`).not.toBeNull();
    });
  }
});

describe('an alias that cannot be attributed still fails open', () => {
  it('a derived table alias is not judged against a catalog table', () => {
    expect(firstUnknownColumn('SELECT x.anything FROM (SELECT 1 AS anything) x', catalog, 'Postgresql')).toBeNull();
  });

  it('a CTE alias is not judged against a catalog table', () => {
    expect(
      firstUnknownColumn('WITH c AS (SELECT 1 AS n FROM album) SELECT c.n FROM c', catalog, 'Postgresql'),
    ).toBeNull();
  });
});
