import { describe, expect, it } from 'vitest';
import { catalogQueryFor } from '../src/catalog-answers.js';
import { guardSql } from '../src/guard.js';
import { MYSQL_DIALECT, POSTGRES_DIALECT, SQLITE_DIALECT, DUCKDB_DIALECT } from '../src/dialects.js';
import type { SchemaCatalog } from '../src/types.js';

const table = (name: string, primaryKey: string[] = ['id'], kind = 'table') => ({
  name,
  kind,
  columns: [{ name: 'id', dbType: 'int', nullable: false }],
  primaryKey,
  foreignKeys: [],
  uniques: [],
  checks: [],
  indexes: [],
  source: 'db',
});

const catalog = {
  engine: 'postgres',
  schemas: [],
  tables: [table('Orders'), table('Items', []), table('OrderView', [], 'view')],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
} as unknown as SchemaCatalog;

describe('questions worth writing exactly', () => {
  it.each([
    'how many rows are in each table?',
    'row counts per table',
    'which tables have the most rows?',
    'are there any tables without a primary key?',
    'which tables have no primary key?',
  ])('answers %s', (question) => {
    expect(catalogQueryFor(question, catalog, POSTGRES_DIALECT)).not.toBeNull();
  });

  /** Hijacking a data question is far worse than missing a structure one. */
  it.each([
    'how many rows are in the orders table?',
    'show me all rows from orders',
    'which customers have no primary contact?',
    'how many orders are there?',
    'which order has the most items?',
    'what is the total revenue per product category?',
    'list customers from the UK',
  ])('leaves %s to the model', (question) => {
    expect(catalogQueryFor(question, catalog, POSTGRES_DIALECT)).toBeNull();
  });
});

describe('the row-count query it writes', () => {
  it('leaves a data question that names a table alone', () => {
    // "the most recent rows from the orders table" says "most" and "rows", but answering it with a
    // row count of every table is a silently wrong answer to a question about one table's rows.
    for (const q of [
      'show me the most recent rows from the orders table',
      'give me the biggest records in the customers table',
      'show the 10 most recent records in the audit table',
      'what are the most expensive rows in the pricing table',
    ]) {
      expect(catalogQueryFor(q, catalog, POSTGRES_DIALECT), q).toBeNull();
    }
  });

  const built = catalogQueryFor('how many rows are in each table?', catalog, POSTGRES_DIALECT);

  it('counts every base table', () => {
    expect(built?.sql).toContain('"Orders"');
    expect(built?.sql).toContain('"Items"');
  });

  /** A view has no rows of its own, and counting one would double-count the table behind it. */
  it('leaves views out', () => {
    expect(built?.sql).not.toContain('OrderView');
  });

  it('quotes every name, which is what the model kept getting wrong', () => {
    expect(built?.sql).not.toMatch(/FROM Orders\b/);
  });

  it('orders the result when the question asks which is largest', () => {
    const ranked = catalogQueryFor('which tables have the most rows?', catalog, POSTGRES_DIALECT);
    expect(ranked?.sql).toMatch(/ORDER BY row_count DESC/);
  });

  it('uses the dialect quote character', () => {
    const mysql = catalogQueryFor('how many rows are in each table?', catalog, MYSQL_DIALECT);
    expect(mysql?.sql).toContain('`Orders`');
  });

  it('survives a name holding the quote character itself, which is where hand-built SQL breaks', () => {
    const hostile = {
      ...catalog,
      tables: [table('Ord"ers'), table("Bob's tables")],
    } as unknown as SchemaCatalog;
    const built = catalogQueryFor('how many rows are in each table?', hostile, POSTGRES_DIALECT);
    // Doubled inside the identifier, and doubled again inside the label literal.
    expect(built?.sql).toContain('"Ord""ers"');
    expect(built?.sql).toContain("'Ord\"ers'");
    expect(built?.sql).toContain('"Bob\'s tables"');
    expect(built?.sql).toContain("'Bob''s tables'");
    // And the result is still a statement the guard accepts.
    expect(guardSql({ sql: built!.sql, dialect: POSTGRES_DIALECT }).allowed).toBe(true);
  });

  it('quotes a MySQL name holding a backtick', () => {
    const hostile = { ...catalog, tables: [table('we`ird')] } as unknown as SchemaCatalog;
    const built = catalogQueryFor('how many rows are in each table?', hostile, MYSQL_DIALECT);
    expect(built?.sql).toContain('`we``ird`');
  });
});

describe('the missing-primary-key query it writes', () => {
  it.each([
    ['postgres', POSTGRES_DIALECT, 'information_schema.table_constraints'],
    ['mysql', MYSQL_DIALECT, 'information_schema.TABLE_CONSTRAINTS'],
    ['sqlite', SQLITE_DIALECT, 'pragma_table_info'],
  ])('uses %s own catalog', (_name, dialect, expected) => {
    expect(catalogQueryFor('which tables have no primary key?', catalog, dialect)?.sql).toContain(expected);
  });

  /** An engine with no shape written for it is left to the model rather than guessed at here. */
  it('declines an engine it has no query for', () => {
    expect(catalogQueryFor('which tables have no primary key?', catalog, DUCKDB_DIALECT)).toBeNull();
  });
});

describe('an empty catalog', () => {
  it('has nothing to count', () => {
    const empty = { ...catalog, tables: [] } as unknown as SchemaCatalog;
    expect(catalogQueryFor('how many rows are in each table?', empty, POSTGRES_DIALECT)).toBeNull();
  });
});
