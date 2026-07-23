/**
 * formatCatalogForPrompt / joinGraph / pruneCatalog / estimateTokens across a
 * rich catalog: views, materialized views, comments, PK/FK, NOT NULL, declared
 * enums, sampled values, and callable routines.
 */
import { describe, expect, it } from 'vitest';
import { formatCatalogForPrompt, joinGraph, pruneCatalog, estimateTokens } from '../src/catalog.js';
import type { SchemaCatalog } from '../src/types.js';

const CAT: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['shop'],
  tables: [
    {
      schema: 'shop',
      name: 'customers',
      kind: 'table',
      comment: 'People who buy things',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'region', dbType: 'text', nullable: true, enumValues: ['NA', 'EU', 'APAC'] },
        { name: 'status', dbType: 'text', nullable: true, sampledValues: ['active', 'closed'], comment: 'lifecycle' },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
    {
      schema: 'shop',
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'customer_id', dbType: 'bigint', nullable: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [{ columns: ['customer_id'], refSchema: 'shop', refTable: 'customers', refColumns: ['id'] }],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
    {
      schema: 'shop',
      name: 'active_customers',
      kind: 'view',
      columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
      primaryKey: [],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
    {
      schema: 'shop',
      name: 'revenue_by_region',
      kind: 'materialized_view',
      columns: [{ name: 'region', dbType: 'text', nullable: true }],
      primaryKey: [],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
  ],
  enums: [{ schema: 'shop', name: 'region_kind', values: ['NA', 'EU', 'APAC'] }],
  sequences: [],
  triggers: [],
  routines: [
    { schema: 'shop', name: 'total_revenue', kind: 'function', args: '', returns: 'numeric', volatility: 'stable' },
    { schema: 'shop', name: 'do_write', kind: 'procedure', args: '', volatility: 'volatile' },
  ],
  warnings: [],
  fetchedAt: 'now',
};

describe('formatCatalogForPrompt', () => {
  const text = formatCatalogForPrompt(CAT);
  it('renders tables, a VIEW, and a MATERIALIZED VIEW', () => {
    expect(text).toMatch(/TABLE customers/);
    expect(text).toContain('VIEW active_customers');
    expect(text).toContain('MATERIALIZED VIEW revenue_by_region');
  });
  it('renders the table comment, PK, FK, and NOT NULL', () => {
    expect(text).toContain('People who buy things');
    expect(text).toContain('PK');
    expect(text).toMatch(/FK->.*customers.id/);
    expect(text).toContain('NOT NULL');
  });
  it('renders declared enum values and opt-in sampled values distinctly', () => {
    expect(text).toContain('values: NA|EU|APAC');
    expect(text).toContain('sample values: active|closed');
  });
  it('renders a column comment and the enums + callable-routines sections', () => {
    expect(text).toContain('lifecycle');
    expect(text).toContain('region_kind');
    expect(text).toContain('total_revenue'); // STABLE routine is callable
    expect(text).not.toContain('do_write'); // VOLATILE routine is not offered
  });
});

describe('joinGraph / pruneCatalog / estimateTokens', () => {
  it('joinGraph lists the FK edge', () => {
    expect(joinGraph(CAT).join(' ')).toMatch(/orders.*customers|customers.*orders/i);
  });
  it('joinGraph infers an edge from a *_id column when no FK is declared', () => {
    // Many real databases (e.g. MySQL with the FK checks off) carry naming conventions but no
    // declared constraints; joinGraph recovers the join path from customer_id -> customers.id.
    const noFk: SchemaCatalog = {
      ...CAT,
      tables: CAT.tables.map((t) => (t.name === 'orders' ? { ...t, foreignKeys: [] } : t)),
    };
    const edges = joinGraph(noFk).join('\n');
    expect(edges).toMatch(/orders\.customer_id ~ .*customers\.id.*inferred from naming/i);
  });
  it('joinGraph does not double-count an inferred edge that is already declared', () => {
    // orders.customer_id has a real FK; it must appear once, without the "inferred" tag.
    const edges = joinGraph(CAT);
    const orderEdges = edges.filter((e) => /orders\.customer_id/i.test(e));
    expect(orderEdges).toHaveLength(1);
    expect(orderEdges[0]).not.toMatch(/inferred/i);
  });
  it('pruneCatalog keeps the whole catalog when it fits, and reports zero dropped', () => {
    const r = pruneCatalog(CAT, 'how many customers and orders?');
    expect(r.catalog.tables.length).toBeGreaterThan(0);
    expect(r.dropped).toBe(0);
  });
  it('estimateTokens grows with text length', () => {
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(estimateTokens('a'.repeat(40)));
  });
});

describe('formatCatalogForPrompt extras + pruneCatalog dropping', () => {
  const multi: SchemaCatalog = {
    engine: 'postgres',
    schemas: ['shop', 'analytics'],
    tables: [
      {
        schema: 'shop',
        name: 'big_table',
        kind: 'table',
        rowEstimate: 12345,
        columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
        primaryKey: ['id'],
        foreignKeys: [],
        uniques: [],
        checks: [],
        indexes: [],
        source: 'db',
      },
      {
        schema: 'shop',
        name: 'big_table_2024',
        kind: 'table',
        partitionOf: 'big_table',
        columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
        primaryKey: [],
        foreignKeys: [],
        uniques: [],
        checks: [],
        indexes: [],
        source: 'db',
      },
      {
        schema: 'analytics',
        name: 'metrics',
        kind: 'table',
        columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
        primaryKey: ['id'],
        foreignKeys: [],
        uniques: [],
        checks: [],
        indexes: [],
        source: 'db',
      },
    ],
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: 'now',
  };
  it('qualifies names across multiple schemas, shows a row estimate, and skips a partition child', () => {
    const t = formatCatalogForPrompt(multi);
    expect(t).toContain('shop.big_table');
    expect(t).toContain('analytics.metrics');
    expect(t).toMatch(/~12345 rows/);
    expect(t).not.toContain('big_table_2024'); // partition child collapsed to parent
  });

  it('pruneCatalog drops the least-relevant tables under a tight budget', () => {
    const r = pruneCatalog(multi, 'metrics analytics', { maxTables: 1, maxSchemaTokens: 600 });
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.catalog.tables.length).toBeLessThan(multi.tables.length);
  });
});
