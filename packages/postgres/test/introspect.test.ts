/**
 * Catalog assembly from fixture pg_catalog rows - no database needed. A fake
 * Queryable dispatches each introspection query on a distinctive SQL fragment,
 * so every mapping (enums, partitions, routines, triggers, sequences,
 * extensions, view definitions, value sampling) is exercised offline.
 */

import { describe, expect, it } from 'vitest';
import { introspectPostgres } from '../src/introspect.js';

type Rows = Record<string, unknown>[];

interface FakeOptions {
  /** Rows returned by DISTINCT sampling SELECTs, keyed by column name. */
  samples?: Record<string, Rows>;
  /** When false, the pool exposes no connect() (sampling runs on the pool). */
  withClient?: boolean;
}

/** Fake pg pool dispatching on a SQL fragment; unmatched queries return no rows. */
function fakeDb(handlers: Record<string, Rows | (() => never)>, opts: FakeOptions = {}) {
  const seen: string[] = [];
  const run = (text: string): { rows: Rows } => {
    seen.push(text);
    if (text.trim().startsWith('SELECT DISTINCT')) {
      const col = /SELECT DISTINCT "([^"]+)"/.exec(text)?.[1] ?? '';
      return { rows: opts.samples?.[col] ?? [] };
    }
    for (const [fragment, rows] of Object.entries(handlers)) {
      if (text.includes(fragment)) {
        if (typeof rows === 'function') rows();
        return { rows };
      }
    }
    return { rows: [] };
  };
  const client = {
    query: async (text: string) => run(text),
    release: () => {},
  };
  const db: {
    seen: string[];
    query: (text: string, params?: unknown[]) => Promise<{ rows: Rows }>;
    connect?: () => Promise<typeof client>;
  } = {
    seen,
    query: async (text: string) => run(text),
  };
  if (opts.withClient !== false) db.connect = async () => client;
  return db;
}

describe('introspectPostgres', () => {
  it('assembles tables, views and matviews with columns, enums and view definitions', async () => {
    const db = fakeDb({
      'FROM pg_namespace n': [{ nspname: 'public' }],
      'FROM pg_attribute a': [
        {
          schema: 'public',
          table: 'orders',
          column: 'id',
          relkind: 'r',
          type: 'bigint',
          notnull: true,
          ord: 1,
          generated: false,
          default_expr: "nextval('s')",
          comment: 'the id',
          base_type: 'int8',
          typtype: 'b',
        },
        {
          schema: 'public',
          table: 'orders',
          column: 'status',
          relkind: 'r',
          type: 'order_status',
          notnull: false,
          ord: 2,
          generated: false,
          default_expr: null,
          comment: null,
          base_type: 'order_status',
          typtype: 'e',
        },
        {
          schema: 'public',
          table: 'order_report',
          column: 'total',
          relkind: 'v',
          type: 'numeric',
          notnull: false,
          ord: 1,
          generated: true,
          default_expr: null,
          comment: null,
          base_type: 'numeric',
          typtype: 'b',
        },
      ],
      'JOIN pg_enum e': [
        { schema: 'public', name: 'order_status', label: 'open', ord: 1 },
        { schema: 'public', name: 'order_status', label: 'closed', ord: 2 },
      ],
      'CASE WHEN c.relkind': [
        {
          schema: 'public',
          name: 'orders',
          kind: 'r',
          comment: 'orders table',
          row_estimate: 1000,
          is_partition: false,
          partition_of: null,
          definition: null,
          is_partitioned: false,
        },
        {
          schema: 'public',
          name: 'order_report',
          kind: 'v',
          comment: null,
          row_estimate: 0,
          is_partition: false,
          partition_of: null,
          definition: 'SELECT sum(total) FROM orders',
          is_partitioned: false,
        },
        {
          schema: 'public',
          name: 'orders_2024',
          kind: 'r',
          comment: null,
          row_estimate: -1,
          is_partition: true,
          partition_of: 'public.orders',
          definition: null,
          is_partitioned: false,
        },
      ],
    });

    const catalog = await introspectPostgres(db);
    expect(catalog.engine).toBe('postgres');
    expect(catalog.schemas).toEqual(['public']);

    const orders = catalog.tables.find((t) => t.name === 'orders')!;
    expect(orders.kind).toBe('table');
    expect(orders.comment).toBe('orders table');
    expect(orders.rowEstimate).toBe(1000);
    expect(orders.columns[0]).toEqual({
      name: 'id',
      dbType: 'bigint',
      nullable: false,
      default: "nextval('s')",
      generated: false,
      comment: 'the id',
    });
    // Enum column carries the resolved labels.
    expect(orders.columns[1]!.enumValues).toEqual(['open', 'closed']);

    const view = catalog.tables.find((t) => t.name === 'order_report')!;
    expect(view.kind).toBe('view');
    expect(view.definition).toBe('SELECT sum(total) FROM orders');
    expect(view.columns[0]!.generated).toBe(true);

    // A negative reltuples estimate clamps to 0; partition metadata is carried.
    const part = catalog.tables.find((t) => t.name === 'orders_2024')!;
    expect(part.rowEstimate).toBe(0);
    expect(part.partitionOf).toBe('public.orders');

    expect(catalog.enums).toEqual([{ schema: 'public', name: 'order_status', values: ['open', 'closed'] }]);
  });

  it('maps constraints (pk / unique / check / fk) and indexes', async () => {
    const db = fakeDb({
      'FROM pg_namespace n': [{ nspname: 'public' }],
      'CASE WHEN c.relkind': [
        {
          schema: 'public',
          name: 'orders',
          kind: 'r',
          comment: null,
          row_estimate: 5,
          is_partition: false,
          partition_of: null,
          definition: null,
          is_partitioned: false,
        },
      ],
      'FROM pg_constraint con': [
        { schema: 'public', table: 'orders', name: 'pk', contype: 'p', def: null, cols: ['id'] },
        { schema: 'public', table: 'orders', name: 'uq_code', contype: 'u', def: null, cols: ['code'] },
        { schema: 'public', table: 'orders', name: 'ck_pos', contype: 'c', def: 'CHECK (total > 0)', cols: [] },
        {
          schema: 'public',
          table: 'orders',
          name: 'fk_cust',
          contype: 'f',
          def: null,
          cols: ['cust_id'],
          ref_schema: 'public',
          ref_table: 'customers',
          ref_cols: ['id'],
        },
      ],
      'FROM pg_index ix': [
        {
          schema: 'public',
          table: 'orders',
          name: 'ix_total',
          unique: false,
          method: 'btree',
          def: 'CREATE INDEX ix_total ON orders (total, code)',
          predicate: 'total > 0',
        },
      ],
    });

    const catalog = await introspectPostgres(db);
    const orders = catalog.tables[0]!;
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.uniques).toEqual([['code']]);
    expect(orders.checks).toEqual(['CHECK (total > 0)']);
    expect(orders.foreignKeys).toEqual([
      { name: 'fk_cust', columns: ['cust_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] },
    ]);
    expect(orders.indexes).toEqual([
      {
        name: 'ix_total',
        columns: ['total', 'code'],
        unique: false,
        method: 'btree',
        predicate: 'total > 0',
        definition: 'CREATE INDEX ix_total ON orders (total, code)',
      },
    ]);
  });

  it('maps triggers (timing + events from def), routines with volatility, sequences and extensions', async () => {
    const db = fakeDb({
      'FROM pg_namespace n': [{ nspname: 'public' }],
      'FROM pg_trigger tg': [
        {
          schema: 'public',
          table: 'orders',
          name: 'trg_audit',
          enabled: true,
          def: 'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE ON orders',
        },
        {
          schema: 'public',
          table: 'orders',
          name: 'trg_off',
          enabled: false,
          def: 'CREATE TRIGGER trg_off BEFORE DELETE ON orders',
        },
      ],
      'FROM pg_proc p': [
        {
          schema: 'public',
          name: 'total_sales',
          args: 'year integer',
          returns: 'numeric',
          language: 'sql',
          volatility: 's',
          secdef: false,
          kind: 'f',
        },
        {
          schema: 'public',
          name: 'do_work',
          args: '',
          returns: 'void',
          language: 'plpgsql',
          volatility: 'v',
          secdef: true,
          kind: 'p',
        },
      ],
      "c.relkind = 'S'": [{ schema: 'public', name: 'orders_id_seq' }],
      'FROM pg_extension': [{ extname: 'pgcrypto' }, { extname: 'uuid-ossp' }],
    });

    const catalog = await introspectPostgres(db);
    expect(catalog.triggers).toEqual([
      {
        name: 'trg_audit',
        schema: 'public',
        table: 'orders',
        timing: 'AFTER',
        events: ['INSERT', 'UPDATE'],
        enabled: true,
        definition: 'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE ON orders',
      },
      {
        name: 'trg_off',
        schema: 'public',
        table: 'orders',
        timing: 'BEFORE',
        events: ['DELETE'],
        enabled: false,
        definition: 'CREATE TRIGGER trg_off BEFORE DELETE ON orders',
      },
    ]);
    expect(catalog.routines).toEqual([
      {
        schema: 'public',
        name: 'total_sales',
        kind: 'function',
        args: 'year integer',
        returns: 'numeric',
        language: 'sql',
        volatility: 'stable',
        securityDefiner: false,
      },
      {
        schema: 'public',
        name: 'do_work',
        kind: 'procedure',
        args: '',
        returns: 'void',
        language: 'plpgsql',
        volatility: 'volatile',
        securityDefiner: true,
      },
    ]);
    expect(catalog.sequences).toEqual([{ schema: 'public', name: 'orders_id_seq' }]);
    expect(catalog.extensions).toEqual(['pgcrypto', 'uuid-ossp']);
  });

  it('turns an unreadable catalog view into a warning, and defaults schemas to public', async () => {
    const db = fakeDb({
      'FROM pg_namespace n': [],
      'FROM pg_trigger tg': () => {
        throw new Error('permission denied for table pg_trigger');
      },
    });
    const catalog = await introspectPostgres(db);
    expect(catalog.schemas).toEqual(['public']);
    expect(catalog.warnings.some((w) => w.includes('triggers'))).toBe(true);
  });

  it('samples short text columns on a dedicated client when opted in', async () => {
    const db = fakeDb(
      {
        'FROM pg_namespace n': [{ nspname: 'public' }],
        'FROM pg_attribute a': [
          {
            schema: 'public',
            table: 'orders',
            column: 'region',
            relkind: 'r',
            type: 'text',
            notnull: false,
            ord: 1,
            generated: false,
            default_expr: null,
            comment: null,
            base_type: 'text',
            typtype: 'b',
          },
        ],
        'CASE WHEN c.relkind': [
          {
            schema: 'public',
            name: 'orders',
            kind: 'r',
            comment: null,
            row_estimate: 5,
            is_partition: false,
            partition_of: null,
            definition: null,
            is_partitioned: false,
          },
        ],
      },
      { samples: { region: [{ v: 'EU' }, { v: 'US' }] } },
    );

    const catalog = await introspectPostgres(db, { sampleColumnValues: true });
    expect(catalog.tables[0]!.columns[0]!.sampledValues).toEqual(['EU', 'US']);
    // Sampling ran a read-only bounded transaction on the dedicated client.
    expect(db.seen).toContain('BEGIN READ ONLY');
    expect(db.seen.some((s) => s.startsWith('SET LOCAL statement_timeout'))).toBe(true);
  });
});
