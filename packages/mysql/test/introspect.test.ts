/**
 * Catalog assembly from fixture information_schema rows - no database needed.
 * buildMysqlCatalog is the pure mapper; introspectMysql is exercised through a
 * fake MysqlQueryable to cover query dispatch, permission tolerance and sampling.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMysqlCatalog,
  introspectMysql,
  type MysqlIntrospectRows,
  type MysqlQueryable,
} from '../src/introspect.js';

const EMPTY: MysqlIntrospectRows = {
  cols: [],
  tablesMeta: [],
  views: [],
  keyCols: [],
  stats: [],
  trg: [],
  routines: [],
};

describe('buildMysqlCatalog', () => {
  it('assembles columns with nullability, defaults, generated, comments and enum values', () => {
    const catalog = buildMysqlCatalog('app', {
      ...EMPTY,
      tablesMeta: [{ TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: 'People', TABLE_ROWS: 12 }],
      cols: [
        {
          TABLE_NAME: 'users',
          COLUMN_NAME: 'id',
          COLUMN_TYPE: 'bigint unsigned',
          IS_NULLABLE: 'NO',
          COLUMN_DEFAULT: null,
          COLUMN_COMMENT: '',
          EXTRA: 'auto_increment',
        },
        {
          TABLE_NAME: 'users',
          COLUMN_NAME: 'status',
          COLUMN_TYPE: "enum('active','it''s off','pending')",
          IS_NULLABLE: 'YES',
          COLUMN_DEFAULT: 'active',
          COLUMN_COMMENT: 'state',
          EXTRA: '',
        },
        {
          TABLE_NAME: 'users',
          COLUMN_NAME: 'full_name',
          COLUMN_TYPE: 'varchar(255)',
          IS_NULLABLE: 'YES',
          COLUMN_DEFAULT: null,
          COLUMN_COMMENT: '',
          EXTRA: 'VIRTUAL GENERATED',
        },
      ],
    });

    expect(catalog.engine).toBe('mysql');
    expect(catalog.schemas).toEqual(['app']);
    const users = catalog.tables[0]!;
    expect(users.kind).toBe('table');
    expect(users.comment).toBe('People');
    expect(users.rowEstimate).toBe(12);
    expect(users.source).toBe('db');
    expect(users.columns).toEqual([
      { name: 'id', dbType: 'bigint unsigned', nullable: false, default: null, generated: false, comment: null },
      {
        name: 'status',
        dbType: "enum('active','it''s off','pending')",
        nullable: true,
        default: 'active',
        generated: false,
        comment: 'state',
        // ' escaping: '' -> ' inside a label.
        enumValues: ['active', "it's off", 'pending'],
      },
      { name: 'full_name', dbType: 'varchar(255)', nullable: true, default: null, generated: true, comment: null },
    ]);
  });

  it('groups PKs and composite FKs from KEY_COLUMN_USAGE', () => {
    const catalog = buildMysqlCatalog('app', {
      ...EMPTY,
      tablesMeta: [{ TABLE_NAME: 'orders', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 0 }],
      keyCols: [
        { TABLE_NAME: 'orders', COLUMN_NAME: 'id', CONSTRAINT_NAME: 'PRIMARY', ORDINAL_POSITION: 1 },
        {
          TABLE_NAME: 'orders',
          COLUMN_NAME: 'cust_id',
          CONSTRAINT_NAME: 'fk_cust',
          REFERENCED_TABLE_NAME: 'customers',
          REFERENCED_COLUMN_NAME: 'id',
          ORDINAL_POSITION: 1,
        },
        {
          TABLE_NAME: 'orders',
          COLUMN_NAME: 'cust_region',
          CONSTRAINT_NAME: 'fk_cust',
          REFERENCED_TABLE_NAME: 'customers',
          REFERENCED_COLUMN_NAME: 'region',
          ORDINAL_POSITION: 2,
        },
      ],
    });
    const orders = catalog.tables[0]!;
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.foreignKeys).toEqual([
      { columns: ['cust_id', 'cust_region'], refTable: 'customers', refColumns: ['id', 'region'] },
    ]);
  });

  it('builds indexes and derives uniques from unique indexes (excluding PRIMARY)', () => {
    const catalog = buildMysqlCatalog('app', {
      ...EMPTY,
      tablesMeta: [{ TABLE_NAME: 't', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: null }],
      stats: [
        {
          TABLE_NAME: 't',
          INDEX_NAME: 'PRIMARY',
          NON_UNIQUE: 0,
          COLUMN_NAME: 'id',
          SEQ_IN_INDEX: 1,
          INDEX_TYPE: 'BTREE',
        },
        {
          TABLE_NAME: 't',
          INDEX_NAME: 'uq_email',
          NON_UNIQUE: 0,
          COLUMN_NAME: 'email',
          SEQ_IN_INDEX: 1,
          INDEX_TYPE: 'BTREE',
        },
        {
          TABLE_NAME: 't',
          INDEX_NAME: 'ix_name',
          NON_UNIQUE: 1,
          COLUMN_NAME: 'first',
          SEQ_IN_INDEX: 1,
          INDEX_TYPE: 'BTREE',
        },
        {
          TABLE_NAME: 't',
          INDEX_NAME: 'ix_name',
          NON_UNIQUE: 1,
          COLUMN_NAME: 'last',
          SEQ_IN_INDEX: 2,
          INDEX_TYPE: 'BTREE',
        },
      ],
    });
    const t = catalog.tables[0]!;
    expect(t.rowEstimate).toBeNull();
    expect(t.indexes).toEqual([
      { name: 'PRIMARY', columns: ['id'], unique: true, method: 'BTREE' },
      { name: 'uq_email', columns: ['email'], unique: true, method: 'BTREE' },
      { name: 'ix_name', columns: ['first', 'last'], unique: false, method: 'BTREE' },
    ]);
    // PRIMARY is excluded; the non-unique multi-column index is not a unique.
    expect(t.uniques).toEqual([['email']]);
  });

  it('marks views and carries their definition; base tables have none', () => {
    const catalog = buildMysqlCatalog('app', {
      ...EMPTY,
      tablesMeta: [
        { TABLE_NAME: 'active_users', TABLE_TYPE: 'VIEW', TABLE_COMMENT: '', TABLE_ROWS: null },
        { TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: null },
        { TABLE_NAME: 'empty_view', TABLE_TYPE: 'VIEW', TABLE_COMMENT: '', TABLE_ROWS: null },
      ],
      views: [
        { TABLE_NAME: 'active_users', VIEW_DEFINITION: 'select * from users where active' },
        { TABLE_NAME: 'empty_view', VIEW_DEFINITION: null },
      ],
    });
    const [view, base, emptyView] = catalog.tables;
    expect(view!.kind).toBe('view');
    expect(view!.definition).toBe('select * from users where active');
    expect(base!.kind).toBe('table');
    expect(base!.definition).toBeNull();
    expect(emptyView!.definition).toBeNull();
  });

  it('maps triggers (timing normalized) and routines (deterministic -> stable)', () => {
    const catalog = buildMysqlCatalog('app', {
      ...EMPTY,
      trg: [
        {
          TRIGGER_NAME: 'trg_ins',
          EVENT_OBJECT_TABLE: 'users',
          ACTION_TIMING: 'before',
          EVENT_MANIPULATION: 'INSERT',
          ACTION_STATEMENT: 'BEGIN END',
        },
        {
          TRIGGER_NAME: 'trg_weird',
          EVENT_OBJECT_TABLE: 'users',
          ACTION_TIMING: 'DURING',
          EVENT_MANIPULATION: 'UPDATE',
          ACTION_STATEMENT: null,
        },
      ],
      routines: [
        {
          ROUTINE_NAME: 'calc',
          ROUTINE_TYPE: 'FUNCTION',
          DTD_IDENTIFIER: 'int(11)',
          IS_DETERMINISTIC: 'YES',
          DATA_TYPE: 'int',
        },
        {
          ROUTINE_NAME: 'archive',
          ROUTINE_TYPE: 'PROCEDURE',
          DTD_IDENTIFIER: null,
          IS_DETERMINISTIC: 'NO',
          DATA_TYPE: null,
        },
      ],
    });
    expect(catalog.triggers).toEqual([
      {
        name: 'trg_ins',
        table: 'users',
        timing: 'BEFORE',
        events: ['INSERT'],
        enabled: true,
        definition: 'BEGIN END',
      },
      { name: 'trg_weird', table: 'users', timing: 'UNKNOWN', events: ['UPDATE'], enabled: true, definition: null },
    ]);
    expect(catalog.routines).toEqual([
      { name: 'calc', kind: 'function', args: '', returns: 'int(11)', volatility: 'stable' },
      { name: 'archive', kind: 'procedure', args: '', returns: null, volatility: 'unknown' },
    ]);
  });

  it('attaches sampled values to matching non-enum columns, passes warnings through', () => {
    // Key matches the connector's internal delimiter (table + NUL + column).
    const sampled = new Map<string, string[]>([['users\u0000full_name', ['Ann', 'Bob']]]);
    const catalog = buildMysqlCatalog(
      'app',
      {
        ...EMPTY,
        tablesMeta: [{ TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 2 }],
        cols: [
          {
            TABLE_NAME: 'users',
            COLUMN_NAME: 'full_name',
            COLUMN_TYPE: 'varchar(255)',
            IS_NULLABLE: 'YES',
            COLUMN_DEFAULT: null,
            COLUMN_COMMENT: '',
            EXTRA: '',
          },
        ],
      },
      ['Could not read triggers: denied'],
      sampled,
    );
    expect(catalog.tables[0]!.columns[0]).toMatchObject({ name: 'full_name', sampledValues: ['Ann', 'Bob'] });
    expect(catalog.warnings).toEqual(['Could not read triggers: denied']);
  });
});

/** Fake queryable dispatching on a SQL fragment; unmatched queries return no rows. */
function fakeDb(handlers: Record<string, Record<string, unknown>[] | (() => never)>): MysqlQueryable & {
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    async query(sql: string) {
      seen.push(sql);
      for (const [fragment, rows] of Object.entries(handlers)) {
        if (sql.includes(fragment)) {
          if (typeof rows === 'function') rows();
          return rows;
        }
      }
      return [];
    },
  };
}

describe('introspectMysql', () => {
  it('fetches every section and assembles a catalog', async () => {
    const db = fakeDb({
      'information_schema.COLUMNS': [
        {
          TABLE_NAME: 'users',
          COLUMN_NAME: 'id',
          COLUMN_TYPE: 'int',
          IS_NULLABLE: 'NO',
          COLUMN_DEFAULT: null,
          COLUMN_COMMENT: '',
          EXTRA: '',
        },
      ],
      'information_schema.TABLES': [
        { TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 1 },
      ],
    });
    const catalog = await introspectMysql(db, { database: 'app', sampleColumnValues: false });
    expect(catalog.schemas).toEqual(['app']);
    expect(catalog.tables).toHaveLength(1);
    expect(catalog.tables[0]!.columns[0]!.name).toBe('id');
    expect(catalog.warnings).toEqual([]);
  });

  it('turns an unreadable information_schema view into a warning, not a failure', async () => {
    const db = fakeDb({
      'information_schema.TABLES': [
        { TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 1 },
      ],
      'information_schema.TRIGGERS': () => {
        throw new Error('SELECT command denied');
      },
    });
    const catalog = await introspectMysql(db, { database: 'app', sampleColumnValues: false });
    expect(catalog.tables).toHaveLength(1);
    expect(catalog.warnings.some((w) => w.includes('triggers'))).toBe(true);
  });

  it('samples short non-enum text columns on base tables when opted in', async () => {
    const db = fakeDb({
      'information_schema.COLUMNS': [
        {
          TABLE_NAME: 'users',
          COLUMN_NAME: 'code',
          COLUMN_TYPE: 'varchar(10)',
          IS_NULLABLE: 'YES',
          COLUMN_DEFAULT: null,
          COLUMN_COMMENT: '',
          EXTRA: '',
        },
        {
          TABLE_NAME: 'users',
          COLUMN_NAME: 'bio',
          COLUMN_TYPE: 'text',
          IS_NULLABLE: 'YES',
          COLUMN_DEFAULT: null,
          COLUMN_COMMENT: '',
          EXTRA: '',
        },
      ],
      'information_schema.TABLES': [
        { TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 3 },
      ],
      // The sampling SELECT for the `code` column.
      'DISTINCT `code`': [{ v: 'A' }, { v: 'B' }],
    });
    const catalog = await introspectMysql(db, { database: 'app', sampleColumnValues: true });
    const cols = catalog.tables[0]!.columns;
    expect(cols.find((c) => c.name === 'code')!.sampledValues).toEqual(['A', 'B']);
    // A non-sampleable text column is never probed.
    expect(cols.find((c) => c.name === 'bio')!.sampledValues).toBeUndefined();
  });

  it('does not sample columns on a view', async () => {
    const db = fakeDb({
      'information_schema.COLUMNS': [
        {
          TABLE_NAME: 'v',
          COLUMN_NAME: 'code',
          COLUMN_TYPE: 'varchar(10)',
          IS_NULLABLE: 'YES',
          COLUMN_DEFAULT: null,
          COLUMN_COMMENT: '',
          EXTRA: '',
        },
      ],
      'information_schema.TABLES': [{ TABLE_NAME: 'v', TABLE_TYPE: 'VIEW', TABLE_COMMENT: '', TABLE_ROWS: null }],
      'information_schema.VIEWS': [{ TABLE_NAME: 'v', VIEW_DEFINITION: 'select 1' }],
    });
    await introspectMysql(db, { database: 'app', sampleColumnValues: true });
    expect(db.seen.some((s) => s.includes('DISTINCT `code`'))).toBe(false);
  });
});
