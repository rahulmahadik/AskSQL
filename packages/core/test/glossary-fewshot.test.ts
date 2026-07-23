/**
 * Semantic glossary + few-shot feedback loop (deterministic,
 * mock-model). Verifies both reach the prompt and the store round-trips.
 */
import { describe, expect, it } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { MemoryFewShotStore } from '../src/history.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'total_cents', dbType: 'bigint', nullable: false },
        { name: 'status', dbType: 'text', nullable: false },
      ],
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
class Fake implements Connector {
  engine = 'postgres' as const;
  dialect = POSTGRES_DIALECT;
  capabilities = {
    supportsCancel: true,
    supportsExplain: true,
    supportsSchemas: true,
    readOnlySession: true,
    supportsMatViews: true,
    supportsTriggers: true,
    supportsRoutines: true,
  };
  id = 'f';
  name = 'F';
  async connect() {}
  async close() {}
  async introspect() {
    return CATALOG;
  }
  async execute(): Promise<ResultSet> {
    return {
      columns: [{ name: 'n', kind: 'number' }],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
      warnings: [],
    };
  }
}
/** A model that echoes the prompt it received so tests can inspect it. */
function capturing(): { model: CustomModel; prompts: string[] } {
  const prompts: string[] = [];
  const model: CustomModel = async ({ prompt }) => {
    prompts.push(prompt);
    return '```sql\nSELECT count(*) FROM orders\n```';
  };
  return { model, prompts };
}

describe('glossary reaches the prompt', () => {
  it('glossary terms are injected into the user prompt', async () => {
    const { model, prompts } = capturing();
    const engine = createAskSql({
      connectors: [new Fake()],
      model,
      glossary: [{ term: 'revenue', definition: 'sum of orders.total_cents where status = paid' }],
    });
    await engine.ask('what is our revenue?');
    expect(prompts[0]).toMatch(/Business glossary/);
    expect(prompts[0]).toMatch(/revenue: sum of orders\.total_cents/);
  });
});

describe('few-shot feedback loop', () => {
  it('recordFeedback stores an approved pair, retrieved into a later prompt', async () => {
    const { model, prompts } = capturing();
    const store = new MemoryFewShotStore();
    const engine = createAskSql({ connectors: [new Fake()], model, fewShots: store });

    // Approve an example.
    await engine.recordFeedback('total paid revenue', "SELECT sum(total_cents) FROM orders WHERE status = 'paid'");

    // A similar later question should retrieve it as a few-shot.
    await engine.ask('what is the paid revenue total?');
    const p = prompts[prompts.length - 1]!;
    expect(p).toMatch(/Examples of good answers/);
    expect(p).toMatch(/total paid revenue/);
    expect(p).toMatch(/status = 'paid'/);
  });

  it('recordFeedback refuses to memorize an unsafe (non-SELECT) example', async () => {
    const store = new MemoryFewShotStore();
    const engine = createAskSql({ connectors: [new Fake()], model: async () => 'x', fewShots: store });
    await engine.recordFeedback('drop it', 'DROP TABLE orders');
    const got = await store.retrieve('f', 'drop it', 4);
    expect(got).toHaveLength(0); // never stored
  });

  it('store retrieval ranks by term overlap and de-dups questions', async () => {
    const store = new MemoryFewShotStore();
    await store.add('f', { question: 'revenue by region', sql: 'SELECT 1' });
    await store.add('f', { question: 'orders per customer', sql: 'SELECT 2' });
    await store.add('f', { question: 'revenue by region', sql: 'SELECT 3' }); // dup -> replaces
    const got = await store.retrieve('f', 'show revenue by region please', 4);
    expect(got[0]!.question).toBe('revenue by region');
    expect(got[0]!.sql).toBe('SELECT 3'); // latest wins
  });
});
