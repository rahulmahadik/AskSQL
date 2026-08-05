/**
 * A spreadsheet exported to CSV has headers like `Order Status`. Those become real column names,
 * and a model copies whatever the prompt shows it - so the prompt has to show the quoted form, and
 * the guard has to catch the MySQL backticks a model reaches for out of habit.
 */
import { describe, expect, it } from 'vitest';
import { formatCatalogForPrompt, joinGraph } from '../src/catalog.js';
import { guardSql } from '../src/guard.js';
import { DUCKDB_DIALECT, MYSQL_DIALECT, POSTGRES_DIALECT } from '../src/dialects.js';
import type { SchemaCatalog, TableInfo } from '../src/types.js';

function table(name: string, columns: string[]): TableInfo {
  return {
    name,
    schema: null,
    kind: 'table',
    columns: columns.map((c) => ({ name: c, dbType: 'VARCHAR', nullable: true, comment: null })),
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
    comment: null,
  } as unknown as TableInfo;
}

function catalog(engine: SchemaCatalog['engine'], tables: TableInfo[]): SchemaCatalog {
  return {
    engine,
    schemas: [],
    tables,
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: new Date(0).toISOString(),
  };
}

describe('names that cannot be written bare are shown quoted', () => {
  it('quotes spreadsheet headers with spaces', () => {
    const text = formatCatalogForPrompt(catalog('duckdb', [table('orders', ['Order ID', 'Order Status', 'Notes'])]));
    expect(text).toContain('"Order ID"');
    expect(text).toContain('"Order Status"');
    // A name that is already a plain word stays bare, so ordinary schemas read the same as before.
    expect(text).toContain(' Notes ');
    expect(text).not.toContain('"Notes"');
  });

  it('uses the dialect quote character', () => {
    const text = formatCatalogForPrompt(catalog('mysql', [table('orders', ['Order Status'])]));
    expect(text).toContain('`Order Status`');
  });

  it('quotes a table name that needs it', () => {
    const text = formatCatalogForPrompt(catalog('duckdb', [table('sales report', ['id'])]));
    expect(text).toContain('"sales report"');
  });
});

describe('backtick quoting is caught before it reaches the driver', () => {
  it('blocks MySQL backticks on every other dialect', () => {
    for (const dialect of [POSTGRES_DIALECT, DUCKDB_DIALECT]) {
      const verdict = guardSql({ sql: 'SELECT `Customer Name` FROM orders', dialect });
      expect(verdict.allowed).toBe(false);
      expect(verdict.ruleId).toBe('backtick_identifier');
      // The reason has to name the right quote character: it IS the repair instruction.
      expect(verdict.reason).toContain(dialect.quoteChar);
    }
  });

  it('allows them on MySQL, where they are correct', () => {
    expect(guardSql({ sql: 'SELECT `Customer Name` FROM orders', dialect: MYSQL_DIALECT }).allowed).toBe(true);
  });

  it('ignores a backtick inside a string literal', () => {
    const sql = "SELECT id FROM orders WHERE notes = 'has a ` in it'";
    expect(guardSql({ sql, dialect: POSTGRES_DIALECT }).allowed).toBe(true);
  });
});

describe('a name the engine would not read back as itself', () => {
  it('quotes mixed case where the engine folds it', () => {
    // PostgreSQL folds an unquoted name to lower case, so `OrderDate` would become `orderdate`.
    expect(formatCatalogForPrompt(catalog('postgres', [table('t', ['OrderDate'])]))).toContain('"OrderDate"');
    // Oracle folds to upper case, so a lower-case name is the one at risk there.
    expect(formatCatalogForPrompt(catalog('oracle', [table('t', ['order_date'])]))).toContain('"order_date"');
    expect(formatCatalogForPrompt(catalog('oracle', [table('t', ['ORDER_DATE'])]))).toContain(' ORDER_DATE ');
    // SQLite, DuckDB and MySQL match identifiers case-insensitively, so nothing is lost.
    expect(formatCatalogForPrompt(catalog('sqlite', [table('t', ['OrderDate'])]))).toContain(' OrderDate ');
  });

  it('quotes a reserved word used as a column name', () => {
    for (const word of ['order', 'group', 'user', 'from', 'desc', 'check']) {
      expect(formatCatalogForPrompt(catalog('postgres', [table('t', [word])]))).toContain(`"${word}"`);
    }
  });

  it('escapes the quote character inside a name', () => {
    const text = formatCatalogForPrompt(catalog('postgres', [table('t', ['we"ird'])]));
    expect(text).toContain('"we""ird"');
  });

  it('renders the same name the same way in the join graph', () => {
    const items = table('Order Items', ['Order ID']);
    const list = table('Order List', ['ID No']);
    const withFk = {
      ...items,
      foreignKeys: [{ columns: ['Order ID'], refTable: 'Order List', refColumns: ['ID No'], refSchema: null }],
    } as unknown as TableInfo;
    const edges = joinGraph(catalog('postgres', [withFk, list]));
    expect(edges[0]).toBe('"Order Items"."Order ID" = "Order List"."ID No"');
  });
});
