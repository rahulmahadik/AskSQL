/**
 * classifyColumnKind branch coverage and the catalog prompt renderer's
 * less-trodden sections: enum types, callable read-only functions, sampled
 * values, view/matview heads, file source and value sanitization.
 */

import { describe, expect, it } from 'vitest';
import { classifyColumnKind } from '../src/coltype.js';
import { formatCatalogForPrompt, joinGraph } from '../src/catalog.js';
import type { SchemaCatalog } from '../src/types.js';

describe('classifyColumnKind', () => {
  it('maps each type family, including float -> number and the unknown fallback', () => {
    expect(classifyColumnKind('boolean')).toBe('boolean');
    expect(classifyColumnKind('bit')).toBe('boolean');
    expect(classifyColumnKind('bigint')).toBe('bigint');
    expect(classifyColumnKind('numeric(10,2)')).toBe('decimal');
    expect(classifyColumnKind('integer')).toBe('number');
    expect(classifyColumnKind('double precision')).toBe('number');
    expect(classifyColumnKind('real')).toBe('number');
    expect(classifyColumnKind('timestamp with time zone')).toBe('timestamp');
    expect(classifyColumnKind('date')).toBe('date');
    expect(classifyColumnKind('jsonb')).toBe('json');
    expect(classifyColumnKind('bytea')).toBe('binary');
    expect(classifyColumnKind('varchar(255)')).toBe('text');
    expect(classifyColumnKind('geometry')).toBe('unknown');
    expect(classifyColumnKind(null)).toBe('unknown');
    expect(classifyColumnKind('')).toBe('unknown');
  });
});

const baseCatalog = (over: Partial<SchemaCatalog>): SchemaCatalog => ({
  engine: 'postgres',
  schemas: ['public'],
  tables: [],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
  ...over,
});

describe('formatCatalogForPrompt', () => {
  it('renders table/view/matview heads, PK/FK/NOT NULL, enum + sample values and comments', () => {
    const catalog = baseCatalog({
      tables: [
        {
          name: 'orders',
          kind: 'table',
          comment: 'the   orders\ntable',
          rowEstimate: 1234,
          columns: [
            { name: 'id', dbType: 'bigint', nullable: false },
            {
              name: 'status',
              dbType: 'order_status',
              nullable: true,
              enumValues: ['open', 'closed'],
              comment: 'lifecycle',
            },
            { name: 'region', dbType: 'text', nullable: true, sampledValues: ['EU', 'US'] },
            { name: 'cust_id', dbType: 'bigint', nullable: true },
          ],
          primaryKey: ['id'],
          foreignKeys: [{ columns: ['cust_id'], refTable: 'customers', refColumns: ['id'] }],
          uniques: [],
          checks: [],
          indexes: [],
          source: 'db',
        },
        {
          name: 'report',
          kind: 'view',
          columns: [{ name: 'total', dbType: 'numeric', nullable: true }],
          primaryKey: [],
          foreignKeys: [],
          uniques: [],
          checks: [],
          indexes: [],
          source: 'db',
        },
        {
          name: 'summary',
          kind: 'materialized_view',
          columns: [],
          primaryKey: [],
          foreignKeys: [],
          uniques: [],
          checks: [],
          indexes: [],
          source: 'file',
        },
      ],
    });

    const text = formatCatalogForPrompt(catalog);
    expect(text).toContain('TABLE orders [~1234 rows] -- the orders table');
    expect(text).toContain(' id bigint PK NOT NULL');
    expect(text).toContain('FK->customers.id');
    expect(text).toContain('values: open|closed');
    expect(text).toContain('sample values: EU|US');
    expect(text).toContain('-- lifecycle');
    expect(text).toContain('VIEW report');
    expect(text).toContain('MATERIALIZED VIEW summary [from uploaded file]');
    // Relationships section derived from the FK.
    expect(text).toContain('RELATIONSHIPS (join paths):');
    expect(text).toContain('orders.cust_id = customers.id');
  });

  it('renders the enum-types and callable read-only functions sections', () => {
    const catalog = baseCatalog({
      enums: [{ schema: 'public', name: 'order_status', values: ['open', 'closed'] }],
      routines: [
        {
          schema: 'public',
          name: 'total_sales',
          kind: 'function',
          args: 'year int',
          returns: 'numeric',
          volatility: 'stable',
        },
        { schema: 'public', name: 'now_ish', kind: 'function', args: '', returns: 'timestamp', volatility: 'volatile' },
        { schema: 'public', name: 'do_work', kind: 'procedure', args: '', returns: null, volatility: 'immutable' },
      ],
    });
    const text = formatCatalogForPrompt(catalog);
    expect(text).toContain('ENUM TYPES:');
    expect(text).toContain('order_status: open|closed');
    expect(text).toContain('CALLABLE READ-ONLY FUNCTIONS');
    // Only the stable/immutable FUNCTION is callable; the volatile fn and the procedure are excluded.
    expect(text).toContain('total_sales(year int) -> numeric');
    expect(text).not.toContain('now_ish');
    expect(text).not.toContain('do_work');
  });

  it('qualifies names and prefixes ref schema when more than one schema is present', () => {
    const catalog = baseCatalog({
      schemas: ['public', 'sales'],
      tables: [
        {
          schema: 'sales',
          name: 'orders',
          kind: 'table',
          columns: [{ name: 'cust_id', dbType: 'bigint', nullable: true }],
          primaryKey: [],
          foreignKeys: [{ columns: ['cust_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] }],
          uniques: [],
          checks: [],
          indexes: [],
          source: 'db',
        },
      ],
    });
    expect(joinGraph(catalog)).toEqual(['sales.orders.cust_id = public.customers.id']);
    expect(formatCatalogForPrompt(catalog)).toContain('TABLE sales.orders');
  });
});
