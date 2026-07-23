/**
 * Catalog assembly from fixture ALL_* dictionary rows - no database needed.
 * buildOracleCatalog is the pure mapper; introspectOracle is exercised through
 * a fake OracleQueryable to cover query dispatch and permission tolerance.
 */

import { describe, expect, it } from 'vitest';
import { buildOracleCatalog, introspectOracle, type OracleQueryable } from '../src/introspect.js';

const EMPTY = {
  tableRows: [],
  colRows: [],
  pkRows: [],
  fkRows: [],
  tabCommentRows: [],
  colCommentRows: [],
  rowEstRows: [],
};

describe('buildOracleCatalog', () => {
  it('assembles tables and views with columns, nullability, defaults and comments', () => {
    const catalog = buildOracleCatalog('HR', {
      ...EMPTY,
      tableRows: [
        { NAME: 'EMPLOYEES', KIND: 'TABLE' },
        { NAME: 'EMP_VIEW', KIND: 'VIEW' },
      ],
      colRows: [
        { TABLE_NAME: 'EMPLOYEES', COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', NULLABLE: 'N', DATA_DEFAULT: null },
        {
          TABLE_NAME: 'EMPLOYEES',
          COLUMN_NAME: 'NAME',
          DATA_TYPE: 'VARCHAR2',
          NULLABLE: 'Y',
          DATA_DEFAULT: "'unknown'",
        },
        { TABLE_NAME: 'EMP_VIEW', COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', NULLABLE: 'Y', DATA_DEFAULT: null },
      ],
      tabCommentRows: [{ TABLE_NAME: 'EMPLOYEES', COMMENTS: 'People' }],
      colCommentRows: [{ TABLE_NAME: 'EMPLOYEES', COLUMN_NAME: 'NAME', COMMENTS: 'Display name' }],
      rowEstRows: [{ TABLE_NAME: 'EMPLOYEES', NUM_ROWS: 42 }],
    });

    expect(catalog.engine).toBe('oracle');
    expect(catalog.schemas).toEqual(['HR']);
    expect(catalog.tables.map((t) => [t.name, t.kind])).toEqual([
      ['EMPLOYEES', 'table'],
      ['EMP_VIEW', 'view'],
    ]);

    const emp = catalog.tables[0]!;
    expect(emp.schema).toBe('HR');
    expect(emp.comment).toBe('People');
    expect(emp.rowEstimate).toBe(42);
    expect(emp.source).toBe('db');
    expect(emp.columns).toEqual([
      { name: 'ID', dbType: 'NUMBER', nullable: false, default: null, comment: null },
      { name: 'NAME', dbType: 'VARCHAR2', nullable: true, default: "'unknown'", comment: 'Display name' },
    ]);

    const view = catalog.tables[1]!;
    expect(view.comment).toBeNull();
    expect(view.rowEstimate).toBeNull();
  });

  it('assembles sequences, triggers, routines, uniques and indexes', () => {
    const catalog = buildOracleCatalog('HR', {
      ...EMPTY,
      tableRows: [{ NAME: 'ORDERS', KIND: 'TABLE' }],
      uniqueRows: [
        { CONSTRAINT_NAME: 'UQ_ORD', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'CODE', POSITION: 1 },
        { CONSTRAINT_NAME: 'UQ_ORD', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'REGION', POSITION: 2 },
      ],
      indexRows: [
        {
          INDEX_NAME: 'IX_ORD_CUST',
          TABLE_NAME: 'ORDERS',
          UNIQUENESS: 'NONUNIQUE',
          COLUMN_NAME: 'CUST_ID',
          COLUMN_POSITION: 1,
        },
      ],
      seqRows: [{ SEQUENCE_NAME: 'ORDERS_SEQ' }],
      triggerRows: [
        {
          TRIGGER_NAME: 'TRG_ORD',
          TABLE_NAME: 'ORDERS',
          TRIGGER_TYPE: 'BEFORE EACH ROW',
          TRIGGERING_EVENT: 'INSERT OR UPDATE',
          STATUS: 'ENABLED',
        },
      ],
      routineRows: [
        { OBJECT_NAME: 'CALC_TOTAL', OBJECT_TYPE: 'FUNCTION' },
        { OBJECT_NAME: 'ARCHIVE_OLD', OBJECT_TYPE: 'PROCEDURE' },
      ],
    });

    expect(catalog.tables[0]!.uniques).toEqual([['CODE', 'REGION']]);
    expect(catalog.tables[0]!.indexes).toEqual([{ name: 'IX_ORD_CUST', columns: ['CUST_ID'], unique: false }]);
    expect(catalog.sequences).toEqual([{ schema: 'HR', name: 'ORDERS_SEQ' }]);
    expect(catalog.triggers).toEqual([
      { name: 'TRG_ORD', schema: 'HR', table: 'ORDERS', timing: 'BEFORE', events: ['INSERT', 'UPDATE'], enabled: true },
    ]);
    expect(catalog.routines.map((r) => [r.name, r.kind])).toEqual([
      ['CALC_TOTAL', 'function'],
      ['ARCHIVE_OLD', 'procedure'],
    ]);
  });

  it('collects primary key columns in position order', () => {
    const catalog = buildOracleCatalog('HR', {
      ...EMPTY,
      tableRows: [{ NAME: 'T', KIND: 'TABLE' }],
      pkRows: [
        { TABLE_NAME: 'T', COLUMN_NAME: 'A', POSITION: 1 },
        { TABLE_NAME: 'T', COLUMN_NAME: 'B', POSITION: 2 },
      ],
    });
    expect(catalog.tables[0]!.primaryKey).toEqual(['A', 'B']);
  });

  it('groups composite foreign keys by constraint with positional referenced columns', () => {
    const catalog = buildOracleCatalog('HR', {
      ...EMPTY,
      tableRows: [{ NAME: 'ORDERS', KIND: 'TABLE' }],
      fkRows: [
        {
          FK_NAME: 'FK_ORD',
          TABLE_NAME: 'ORDERS',
          COLUMN_NAME: 'CUST_ID',
          POSITION: 1,
          REF_OWNER: 'HR',
          REF_TABLE: 'CUSTOMERS',
          REF_COLUMN: 'ID',
        },
        {
          FK_NAME: 'FK_ORD',
          TABLE_NAME: 'ORDERS',
          COLUMN_NAME: 'CUST_REGION',
          POSITION: 2,
          REF_OWNER: 'HR',
          REF_TABLE: 'CUSTOMERS',
          REF_COLUMN: 'REGION',
        },
        {
          FK_NAME: 'FK_OTHER',
          TABLE_NAME: 'ORDERS',
          COLUMN_NAME: 'ITEM_ID',
          POSITION: 1,
          REF_OWNER: 'INV',
          REF_TABLE: 'ITEMS',
          REF_COLUMN: 'ID',
        },
      ],
    });
    expect(catalog.tables[0]!.foreignKeys).toEqual([
      {
        name: 'FK_ORD',
        columns: ['CUST_ID', 'CUST_REGION'],
        refSchema: 'HR',
        refTable: 'CUSTOMERS',
        refColumns: ['ID', 'REGION'],
      },
      { name: 'FK_OTHER', columns: ['ITEM_ID'], refSchema: 'INV', refTable: 'ITEMS', refColumns: ['ID'] },
    ]);
  });

  it('ignores a non-numeric row estimate and passes warnings through', () => {
    const catalog = buildOracleCatalog(
      'HR',
      { ...EMPTY, tableRows: [{ NAME: 'T', KIND: 'TABLE' }], rowEstRows: [{ TABLE_NAME: 'T', NUM_ROWS: 'abc' }] },
      ['could not read x'],
    );
    expect(catalog.tables[0]!.rowEstimate).toBeNull();
    expect(catalog.warnings).toEqual(['could not read x']);
  });
});

/** Fake queryable dispatching on a SQL fragment; unmatched queries return no rows. */
function fakeDb(handlers: Record<string, unknown[] | (() => never)>): OracleQueryable & { binds: unknown[] } {
  const binds: unknown[] = [];
  return {
    binds,
    async execute(sql, b) {
      binds.push(b);
      for (const [fragment, rows] of Object.entries(handlers)) {
        if (sql.includes(fragment)) {
          if (typeof rows === 'function') rows();
          return { rows: rows as unknown[] };
        }
      }
      return { rows: [] };
    },
  };
}

describe('introspectOracle', () => {
  it('scopes every dictionary query to the current schema', async () => {
    const db = fakeDb({
      SYS_CONTEXT: [{ SCHEMA: 'HR' }],
      all_tables: [{ NAME: 'T', KIND: 'TABLE' }],
      all_tab_columns: [{ TABLE_NAME: 'T', COLUMN_NAME: 'C', DATA_TYPE: 'NUMBER', NULLABLE: 'Y', DATA_DEFAULT: null }],
    });
    const catalog = await introspectOracle(db, 4002);
    expect(catalog.schemas).toEqual(['HR']);
    expect(catalog.tables).toHaveLength(1);
    expect(catalog.tables[0]!.columns[0]!.name).toBe('C');
    // Every query after the schema lookup binds the owner.
    expect(db.binds.slice(1).every((b) => (b as Record<string, unknown>)['owner'] === 'HR')).toBe(true);
  });

  it('falls back to the session user when CURRENT_SCHEMA yields nothing', async () => {
    const db = fakeDb({ SYS_CONTEXT: [], 'USER AS SCHEMA': [{ SCHEMA: 'APP' }] });
    const catalog = await introspectOracle(db, 4002);
    expect(catalog.schemas).toEqual(['APP']);
  });

  it('turns an unreadable dictionary view into a warning, not a failure', async () => {
    const db = fakeDb({
      SYS_CONTEXT: [{ SCHEMA: 'HR' }],
      all_tables: [{ NAME: 'T', KIND: 'TABLE' }],
      all_col_comments: () => {
        throw new Error('ORA-00942: table or view does not exist');
      },
    });
    const catalog = await introspectOracle(db, 4002);
    expect(catalog.tables).toHaveLength(1);
    expect(catalog.warnings.some((w) => w.includes('column comments'))).toBe(true);
  });
});
