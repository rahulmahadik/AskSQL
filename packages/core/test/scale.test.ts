/**
 * (large-schema pruning) + (concurrent asks stay isolated) -
 * deterministic, no live deps.
 */
import { describe, expect, it } from 'vitest';
import { pruneCatalog, formatCatalogForPrompt, estimateTokens } from '../src/catalog.js';
import { createAskSql } from '../src/engine.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog, TableInfo } from '../src/types.js';

function bigCatalog(n: number): SchemaCatalog {
  const tables: TableInfo[] = [];
  for (let i = 0; i < n; i++) {
    tables.push({
      name: `noise_${i}`, kind: 'table',
      columns: [{ name: 'id', dbType: 'bigint', nullable: false }, { name: 'blob', dbType: 'text', nullable: true }],
      primaryKey: ['id'], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db',
    });
  }
  // The two tables the question is actually about, linked by FK.
  tables.push({
    name: 'customers', kind: 'table',
    columns: [{ name: 'id', dbType: 'bigint', nullable: false }, { name: 'email', dbType: 'text', nullable: false }],
    primaryKey: ['id'], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db',
  });
  tables.push({
    name: 'invoices', kind: 'table',
    columns: [{ name: 'id', dbType: 'bigint', nullable: false }, { name: 'customer_id', dbType: 'bigint', nullable: false }, { name: 'amount_cents', dbType: 'bigint', nullable: false }],
    primaryKey: ['id'], foreignKeys: [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
    uniques: [], checks: [], indexes: [], source: 'db',
  });
  return { engine: 'postgres', schemas: ['public'], tables, enums: [], sequences: [], triggers: [], routines: [], warnings: [], fetchedAt: 'now' };
}

describe('large-schema pruning', () => {
  it('a 5000-table schema prunes to a small relevant subset under budget', () => {
    const cat = bigCatalog(5000);
    const pruned = pruneCatalog(cat, 'total invoice amount per customer', { maxTables: 30, maxSchemaTokens: 6000 });
    const names = pruned.catalog.tables.map((t) => t.name);
    expect(names).toContain('invoices');
    expect(names).toContain('customers'); // FK-closure pulled it in
    expect(pruned.catalog.tables.length).toBeLessThanOrEqual(30);
    expect(pruned.dropped).toBeGreaterThan(4900);
    // The rendered prompt actually fits the token budget.
    expect(estimateTokens(formatCatalogForPrompt(pruned.catalog))).toBeLessThanOrEqual(6000);
  });

  it('pruning completes quickly on 5000 tables', () => {
    const cat = bigCatalog(5000);
    const start = performance.now();
    pruneCatalog(cat, 'invoice amount per customer', { maxTables: 30 });
    expect(performance.now() - start).toBeLessThan(1500); // generous ceiling
  });
});

// ---- concurrent asks don't cross-wire ----
const CATALOG: SchemaCatalog = {
  engine: 'postgres', schemas: ['public'],
  tables: [
    { name: 'a', kind: 'table', columns: [{ name: 'id', dbType: 'bigint', nullable: false }], primaryKey: ['id'], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db' },
    { name: 'b', kind: 'table', columns: [{ name: 'id', dbType: 'bigint', nullable: false }], primaryKey: ['id'], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db' },
  ],
  enums: [], sequences: [], triggers: [], routines: [], warnings: [], fetchedAt: 'now',
};

class Fake implements Connector {
  engine = 'postgres' as const; dialect = POSTGRES_DIALECT;
  capabilities = { supportsCancel: true, supportsExplain: true, supportsSchemas: true, readOnlySession: true, supportsMatViews: true, supportsTriggers: true, supportsRoutines: true };
  id = 'f'; name = 'F';
  async connect() {} async close() {}
  async introspect() { return CATALOG; }
  async execute(): Promise<ResultSet> { return { columns: [{ name: 'n', kind: 'number' }], rows: [[1]], rowCount: 1, truncated: false, durationMs: 1, warnings: [] }; }
}

describe('concurrent asks stay isolated', () => {
  it('each concurrent ask returns the SQL for its own question', async () => {
    // The mock echoes the question inside the SQL so we can detect cross-wiring;
    // a random delay interleaves the in-flight calls.
    const model: CustomModel = async ({ prompt }) => {
      const m = /Question:\s*(q\d+)/.exec(prompt);
      const tag = m?.[1] ?? 'q?';
      await new Promise((r) => setTimeout(r, (tag.charCodeAt(1) % 5) * 10));
      const table = tag === 'q1' ? 'a' : 'b';
      return `\`\`\`sql\nSELECT id AS ${tag} FROM ${table}\n\`\`\``;
    };
    const engine = createAskSql({ connectors: [new Fake()], model });
    const questions = Array.from({ length: 12 }, (_, i) => `q${i}`);
    const results = await Promise.all(questions.map((q) => engine.ask(q)));
    results.forEach((r, i) => {
      // Each result's SQL must carry ITS OWN question tag, not another's.
      expect(r.sql).toContain(`q${i}`);
    });
  });
});
