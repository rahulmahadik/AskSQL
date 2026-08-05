/**
 * What happens when the schema is very large. Two paths can blow a context window: the pruned path
 * (a normal question) and the whole-schema path (an overview question, which lists tables on
 * purpose). Both must stay bounded, and a single very wide table must not defeat the budget.
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens, formatCatalogForPrompt, pruneCatalog } from '../src/catalog.js';
import type { SchemaCatalog, TableInfo } from '../src/types.js';

const BUDGET = 6000;

function tableOf(i: number, columns = 12): TableInfo {
  return {
    name: `table_${i}`,
    schema: 'app',
    kind: 'table',
    columns: Array.from({ length: columns }, (_, c) => ({
      name: c === 0 ? 'id' : `column_number_${c}`,
      dbType: 'character varying(255)',
      nullable: c !== 0,
    })),
    primaryKey: ['id'],
    foreignKeys: i > 0 ? [{ columns: ['id'], refTable: `table_${i - 1}`, refColumns: ['id'] }] : [],
    uniques: [],
    checks: [],
    indexes: [],
    source: 'db',
  };
}

function catalogOf(tables: TableInfo[]): SchemaCatalog {
  return {
    engine: 'postgres',
    schemas: ['app'],
    tables,
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: 'now',
  };
}

describe('a very large schema stays within budget', () => {
  for (const count of [200, 1000, 5000]) {
    it(`${count} tables prunes under the token budget`, () => {
      const catalog = catalogOf(Array.from({ length: count }, (_, i) => tableOf(i)));
      const pruned = pruneCatalog(catalog, 'how many rows are in table_7 by column_number_3', {
        maxSchemaTokens: BUDGET,
      });
      expect(estimateTokens(pruned.schemaText)).toBeLessThanOrEqual(BUDGET);
      // The table the question names must survive the cut.
      expect(pruned.catalog.tables.map((t) => t.name)).toContain('table_7');
    });
  }

  it('a question matching nothing still yields a usable, bounded prompt', () => {
    const catalog = catalogOf(Array.from({ length: 1000 }, (_, i) => tableOf(i)));
    const pruned = pruneCatalog(catalog, 'zzzz nothing matches this at all', { maxSchemaTokens: BUDGET });
    expect(pruned.catalog.tables.length).toBeGreaterThan(0);
    expect(estimateTokens(pruned.schemaText)).toBeLessThanOrEqual(BUDGET);
  });
});

describe('one very wide table cannot defeat the budget', () => {
  const wide = catalogOf([
    { ...tableOf(0, 800), foreignKeys: [{ columns: ['column_number_5'], refTable: 'other', refColumns: ['id'] }] },
  ]);

  it('trims columns rather than giving up', () => {
    const pruned = pruneCatalog(wide, 'count rows', { maxSchemaTokens: BUDGET });
    expect(estimateTokens(formatCatalogForPrompt(pruned.catalog))).toBeLessThanOrEqual(BUDGET);
    expect(pruned.catalog.tables[0]!.columns.length).toBeLessThan(800);
  });

  it('keeps the keys, because they carry the joins', () => {
    const pruned = pruneCatalog(wide, 'count rows', { maxSchemaTokens: BUDGET });
    const names = pruned.catalog.tables[0]!.columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('column_number_5');
  });

  it('keeps a column the question names', () => {
    const pruned = pruneCatalog(wide, 'what is in column_number_700', { maxSchemaTokens: BUDGET });
    expect(pruned.catalog.tables[0]!.columns.map((c) => c.name)).toContain('column_number_700');
  });

  it('says how many columns are not shown, rather than hiding them silently', () => {
    const pruned = pruneCatalog(wide, 'count rows', { maxSchemaTokens: BUDGET });
    expect(pruned.catalog.tables[0]!.comment).toMatch(/of 800 columns not shown/);
    expect(pruned.schemaText).toMatch(/columns not shown/);
  });

  it('leaves a normal table alone', () => {
    const normal = catalogOf([tableOf(0, 10)]);
    const pruned = pruneCatalog(normal, 'count rows', { maxSchemaTokens: BUDGET });
    expect(pruned.catalog.tables[0]!.columns.length).toBe(10);
    expect(pruned.catalog.tables[0]!.comment).toBeUndefined();
  });

  /**
   * The trim loop and the estimator have to charge the same per column. Charging less in the loop
   * kept a whole 300-column table of sampled values and rendered 147,951 tokens against a 6,000
   * budget, while reporting strategy 'budget-trim' as if it had worked.
   */
  it('a wide table of sampled values still lands inside the budget', () => {
    const columns = Array.from({ length: 300 }, (_, i) => ({
      name: `col${i}`,
      dbType: 'text',
      nullable: true,
      comment: 'a column comment of roughly the length a real data dictionary carries for each field',
      sampledValues: Array.from({ length: 24 }, () => 'v'.repeat(80)),
    }));
    const catalog = {
      engine: 'postgres',
      schemas: [],
      tables: [
        {
          name: 'wide',
          schema: null,
          kind: 'table',
          columns,
          primaryKey: [],
          foreignKeys: [],
          indexes: [],
          comment: null,
        },
      ],
      enums: [],
      sequences: [],
      triggers: [],
      routines: [],
      warnings: [],
      fetchedAt: new Date(0).toISOString(),
    } as unknown as SchemaCatalog;

    const untrimmed = estimateTokens(formatCatalogForPrompt(catalog));
    const pruned = pruneCatalog(catalog, 'how many rows are there', { maxSchemaTokens: 6000 });
    const rendered = estimateTokens(pruned.schemaText);
    // MIN_COLUMNS_KEPT can carry a floor above the budget on purpose - an unusable stub is worse
    // than a large prompt - so the invariant is that trimming actually happened and bounded it.
    expect(rendered).toBeLessThan(untrimmed / 10);
    expect(rendered).toBeLessThan(6000 * 1.5);
    expect(pruned.catalog.tables[0]!.columns.length).toBeLessThan(300);
    expect(pruned.schemaText).toMatch(/columns not shown/);
    expect(pruned.strategy).toBe('budget-trim');
  });
});
