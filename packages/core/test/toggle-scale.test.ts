/**
 * Scale test for the answerSchemaQuestions toggle: 1000+ generated general questions
 * routed through the REAL core engine (ask + explainSchema) with a mock model, under
 * both toggle states. Proves handling is graceful either way - never a crash, never a
 * silent wrong answer.
 *
 * The routing rule mirrors the UI (chatView.ts / ChatPanel.kt): try ask() for SQL; if
 * that can't build a query and the toggle is on, fall back to explainSchema.
 */
import { describe, expect, it } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { AskSqlError } from '../src/errors.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['shop'],
  tables: [
    {
      schema: 'shop',
      name: 'customers',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'region', dbType: 'text', nullable: true },
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
      foreignKeys: [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
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

class FakeConnector implements Connector {
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
  id = 'fake';
  name = 'Fake';
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

// A general question can't be a SQL query: the SQL prompt gets IMPOSSIBLE, the schema-answer
// prompt gets a grounded reply that only names real tables/columns.
const conceptualModel: CustomModel = async ({ system }) => {
  if (/Answer using ONLY the schema/i.test(system)) {
    return 'The orders table links to customers via customer_id. The customers table holds each customer and their region.';
  }
  return 'IMPOSSIBLE: This asks about structure, not answerable as a single SQL query.';
};
// A data question always yields runnable SQL over a real table.
const dataModel: CustomModel = async () => '```sql\nSELECT COUNT(*) FROM shop.customers\n```\nCounts customers.';

type Routed = { mode: 'sql' | 'prose' | 'error'; error?: unknown; grounded?: boolean };
async function route(engine: ReturnType<typeof createAskSql>, q: string, toggleOn: boolean): Promise<Routed> {
  try {
    await engine.ask(q, { connectionId: 'fake' });
    return { mode: 'sql' };
  } catch (e) {
    if (toggleOn && e instanceof AskSqlError && (e.code === 'LLM_BAD_OUTPUT' || e.code === 'LLM_REFUSAL')) {
      const sa = await engine.explainSchema(q, { connectionId: 'fake' });
      return { mode: 'prose', grounded: sa.grounded };
    }
    return { mode: 'error', error: e };
  }
}

// ---- generate 1000+ general questions ----
const OBJECTS = [
  'this database',
  'the schema',
  'this db',
  'the data model',
  'the shop database',
  'the whole database',
  'customers',
  'the customers table',
  'orders',
  'the orders table',
  'the customer data',
  'the order data',
  'this data',
  'the structure',
  'the tables',
  'the relationships',
  'the layout',
  'the design',
  'the customer records',
  'the order records',
  'the reporting tables',
  'the shop schema',
  'the model',
  'everything here',
  'the dataset',
  'the catalog',
  'the entities',
  'the objects',
  'the columns',
  'the fields',
];
const CONCEPTUAL_TEMPLATES: ((o: string) => string)[] = [
  (o) => `Summarize ${o}`,
  (o) => `What is ${o} for?`,
  (o) => `Explain ${o}`,
  (o) => `Give me an overview of ${o}`,
  (o) => `What modules are available in ${o}?`,
  (o) => `How is ${o} structured?`,
  (o) => `Describe the purpose of ${o}`,
  (o) => `What kinds of data are in ${o}?`,
  (o) => `Help me understand ${o}`,
  (o) => `What can you tell me about ${o}?`,
  (o) => `Walk me through ${o}`,
  (o) => `Why does ${o} exist?`,
  (o) => `Tell me about ${o}`,
  (o) => `What does ${o} contain?`,
  (o) => `Break down ${o} for me`,
  (o) => `What is the big picture of ${o}?`,
  (o) => `Introduce me to ${o}`,
  (o) => `What should I know about ${o}?`,
];
const NOUNS = [
  'customers',
  'orders',
  'order_items',
  'products',
  'the shop',
  'regions',
  'the customer table',
  'reporting',
  'inventory',
  'sales',
  'the order items',
  'the products table',
];
const REL_TEMPLATES: ((a: string, b: string) => string)[] = [
  (a, b) => `How is ${a} related to ${b}?`,
  (a, b) => `What connects ${a} and ${b}?`,
  (a, b) => `How do ${a} and ${b} relate?`,
  (a, b) => `Explain the relationship between ${a} and ${b}`,
];

const conceptual: string[] = [];
for (const t of CONCEPTUAL_TEMPLATES) for (const o of OBJECTS) conceptual.push(t(o));
for (const t of REL_TEMPLATES) for (const a of NOUNS) for (const b of NOUNS) if (a !== b) conceptual.push(t(a, b));

const DATA_TEMPLATES: ((o: string) => string)[] = [
  (o) => `How many ${o} are there?`,
  (o) => `Count the ${o}`,
  (o) => `List the ${o}`,
  (o) => `Show the top ${o}`,
  (o) => `What is the total of ${o}?`,
];
const DATA_NOUNS = ['orders', 'customers', 'products', 'paid orders', 'regions', 'recent orders', 'active customers'];
const data: string[] = [];
for (const t of DATA_TEMPLATES) for (const o of DATA_NOUNS) data.push(t(o));

describe('answerSchemaQuestions toggle - scale (1000+ general questions)', () => {
  it(`has a large, varied corpus (${conceptual.length} general + ${data.length} data)`, () => {
    expect(conceptual.length).toBeGreaterThanOrEqual(1000);
    expect(new Set(conceptual).size).toBe(conceptual.length); // all distinct
  });

  it(
    'toggle ON: every general question yields a grounded prose answer, never an error',
    { timeout: 60_000 },
    async () => {
      const engine = createAskSql({ connectors: [new FakeConnector()], model: conceptualModel });
      let prose = 0;
      const bad: string[] = [];
      for (const q of conceptual) {
        const r = await route(engine, q, true);
        if (r.mode === 'prose' && r.grounded) prose++;
        else bad.push(`${q} -> ${r.mode} grounded=${r.grounded}`);
      }
      expect(bad.slice(0, 5)).toEqual([]);
      expect(prose).toBe(conceptual.length);
    },
  );

  it(
    'toggle OFF: every general question fails gracefully with a clean AskSqlError - no crash, no schema answer',
    { timeout: 60_000 },
    async () => {
      const engine = createAskSql({ connectors: [new FakeConnector()], model: conceptualModel });
      const bad: string[] = [];
      for (const q of conceptual) {
        const r = await route(engine, q, false);
        const ok =
          r.mode === 'error' &&
          r.error instanceof AskSqlError &&
          typeof r.error.userMessage === 'string' &&
          r.error.userMessage.length > 0;
        if (!ok) bad.push(`${q} -> ${r.mode}`);
      }
      expect(bad.slice(0, 5)).toEqual([]);
    },
  );

  it('data questions become SQL under both toggle states', { timeout: 30_000 }, async () => {
    const engine = createAskSql({ connectors: [new FakeConnector()], model: dataModel });
    for (const q of data) {
      expect((await route(engine, q, true)).mode).toBe('sql');
      expect((await route(engine, q, false)).mode).toBe('sql');
    }
  });
});
