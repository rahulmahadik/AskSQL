/**
 * The whole-schema answer ("summarise this database") deliberately lists tables rather than pruning
 * to a handful. Unbounded, that is tens of thousands of tokens on a large database - an overflow
 * instead of an overview.
 */
import { describe, expect, it } from 'vitest';
import { createAskSql } from '@asksql/core';
import type { Connector, SchemaCatalog, TableInfo } from '@asksql/core';

function tableOf(i: number): TableInfo {
  return {
    name: `table_${i}`,
    schema: 'app',
    kind: 'table',
    columns: [
      { name: 'id', dbType: 'bigint', nullable: false },
      { name: 'label', dbType: 'text', nullable: true },
    ],
    primaryKey: ['id'],
    foreignKeys: i > 0 ? [{ columns: ['id'], refTable: `table_${i - 1}`, refColumns: ['id'] }] : [],
    uniques: [],
    checks: [],
    indexes: [],
    source: 'db',
  };
}

function harness(tableCount: number) {
  const catalog: SchemaCatalog = {
    engine: 'postgres',
    schemas: ['app'],
    tables: Array.from({ length: tableCount }, (_, i) => tableOf(i)),
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: 'now',
  };
  let prompt = '';
  const connector = {
    id: 'db',
    name: 'App',
    engine: 'postgres',
    dialect: { engine: 'postgres', grammar: 'postgresql', promptLabel: 'PostgreSQL', promptNotes: [] },
    capabilities: {},
    connect: async () => {},
    close: async () => {},
    introspect: async () => catalog,
    query: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0, warnings: [] }),
  } as unknown as Connector;
  const engine = createAskSql({
    connectors: [connector],
    model: async ({ prompt: p }: { prompt: string }) => {
      prompt = p;
      return 'This database stores application records across many related tables.';
    },
    answerSchemaQuestions: true,
  });
  return { engine, promptOf: () => prompt };
}

describe('the whole-schema answer is bounded', () => {
  for (const count of [200, 1000, 5000]) {
    it(`${count} tables produces a prompt a model can actually read`, async () => {
      const { engine, promptOf } = harness(count);
      await engine.explainSchema('summarize this database');
      // ~4 chars per token: this must stay in the low thousands, not the tens of thousands.
      expect(promptOf().length / 4).toBeLessThan(6000);
    });
  }

  it('states the real table count and admits the list is partial', async () => {
    const { engine, promptOf } = harness(5000);
    await engine.explainSchema('summarize this database');
    expect(promptOf()).toContain('exactly 5000 tables');
    expect(promptOf()).toMatch(/more are not shown/);
  });

  it('lists every table when the database is small', async () => {
    const { engine, promptOf } = harness(8);
    await engine.explainSchema('summarize this database');
    expect(promptOf()).toContain('Full list:');
    expect(promptOf()).not.toMatch(/not shown/);
    expect(promptOf()).toContain('table_7');
  });
});
