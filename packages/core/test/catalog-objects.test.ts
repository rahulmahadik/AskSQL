/**
 * Objects that are not tables. A DBA asks about indexes, triggers, procedures and sequences, and
 * those questions can only be answered if the objects are in the prompt - introspecting them and
 * then dropping them before the model sees them is the same as not having them.
 */
import { describe, expect, it } from 'vitest';
import { formatCatalogForPrompt } from '../src/catalog.js';
import type { SchemaCatalog, TableInfo } from '../src/types.js';

function table(name: string, overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    name,
    schema: 'shop',
    kind: 'table',
    columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
    primaryKey: ['id'],
    foreignKeys: [],
    uniques: [],
    checks: [],
    indexes: [],
    source: 'db',
    ...overrides,
  };
}

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['shop'],
  tables: [
    table('orders', {
      indexes: [
        { name: 'orders_pkey', columns: ['id'], unique: true },
        { name: 'orders_customer_idx', columns: ['customer_id'], unique: false },
        { name: 'orders_open_idx', columns: ['status'], unique: false, predicate: "status = 'open'" },
      ],
    }),
    table('customers'),
  ],
  enums: [{ name: 'order_status', values: ['pending', 'paid'] }],
  sequences: [{ schema: 'shop', name: 'orders_id_seq' }],
  triggers: [
    {
      name: 'orders_audit',
      schema: 'shop',
      table: 'orders',
      timing: 'AFTER',
      events: ['INSERT', 'UPDATE'],
      enabled: true,
    },
    { name: 'orders_stale', schema: 'shop', table: 'orders', timing: 'BEFORE', events: ['DELETE'], enabled: false },
  ],
  routines: [
    { schema: 'shop', name: 'recalc_totals', kind: 'procedure', args: 'oid bigint' },
    {
      schema: 'shop',
      name: 'order_count',
      kind: 'function',
      args: 'cid bigint',
      returns: 'bigint',
      volatility: 'stable',
    },
  ],
  warnings: [],
  fetchedAt: 'now',
};

describe('a DBA question can be answered from the prompt', () => {
  const text = formatCatalogForPrompt(CATALOG);

  it('names the indexes on each table', () => {
    expect(text).toContain('orders_customer_idx(customer_id)');
    expect(text).toContain('orders_pkey(id) UNIQUE');
  });

  it('marks a partial index rather than pasting its predicate', () => {
    expect(text).toContain('orders_open_idx(status) WHERE ...');
    expect(text).not.toContain("status = 'open'");
  });

  it('lists triggers with their timing, events and table', () => {
    expect(text).toContain('orders_audit AFTER INSERT/UPDATE ON shop.orders');
  });

  it('marks a disabled trigger as disabled', () => {
    expect(text).toContain('orders_stale BEFORE DELETE ON shop.orders [disabled]');
  });

  it('lists stored procedures, and says they are not callable', () => {
    expect(text).toMatch(/STORED PROCEDURES \(reference only - NEVER call these/);
    expect(text).toContain('recalc_totals(oid bigint)');
  });

  it('still offers read-only functions as callable', () => {
    expect(text).toContain('CALLABLE READ-ONLY FUNCTIONS');
    expect(text).toContain('order_count(cid bigint)');
  });

  it('lists sequences and enums', () => {
    expect(text).toContain('SEQUENCES: orders_id_seq');
    expect(text).toContain('order_status: pending|paid');
  });

  it('says nothing about objects a database does not have', () => {
    const bare = formatCatalogForPrompt({
      ...CATALOG,
      triggers: [],
      sequences: [],
      routines: [],
      tables: [table('orders')],
    });
    expect(bare).not.toContain('TRIGGERS:');
    expect(bare).not.toContain('SEQUENCES:');
    expect(bare).not.toContain('STORED PROCEDURES');
    expect(bare).not.toContain('INDEXES:');
  });
});

describe('a list the renderer cut short says so', () => {
  // A silent cut reads as the complete set: the model concludes a name it was never shown does not
  // exist, and answers "there is no such table" with total confidence.
  const many = <T,>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_v, i) => make(i));

  it('marks triggers, procedures, sequences and enums past the cap', () => {
    const cat: SchemaCatalog = {
      ...CATALOG,
      enums: many(45, (i) => ({ name: `enum_${i}`, values: ['a', 'b'] })),
      sequences: many(45, (i) => ({ schema: 'shop', name: `seq_${i}` })),
      triggers: many(45, (i) => ({
        name: `trg_${i}`,
        schema: 'shop',
        table: 'orders',
        timing: 'AFTER' as const,
        events: ['INSERT'],
        enabled: true,
      })),
      routines: many(45, (i) => ({ schema: 'shop', name: `proc_${i}`, kind: 'procedure' as const, args: '' })),
    };
    const text = formatCatalogForPrompt(cat);
    expect(text).toMatch(/TRIGGERS:.*15 more not shown/);
    expect(text).toMatch(/STORED PROCEDURES.*15 more not shown/);
    expect(text).toMatch(/SEQUENCES:.*15 more not shown/);
    expect(text).toMatch(/ENUM TYPES:.*15 more not shown/);
  });

  it('caps enums at all, which it previously did not', () => {
    const cat: SchemaCatalog = { ...CATALOG, enums: many(200, (i) => ({ name: `enum_${i}`, values: ['a'] })) };
    const rendered = formatCatalogForPrompt(cat).split('\n').filter((l) => /^ enum_\d+:/.test(l));
    expect(rendered.length).toBe(30);
  });

  it('says nothing extra when everything fits', () => {
    expect(formatCatalogForPrompt(CATALOG)).not.toMatch(/more not shown/);
  });
});
