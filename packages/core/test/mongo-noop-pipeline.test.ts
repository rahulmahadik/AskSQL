/**
 * A pipeline that only slices - `[{"$limit":1000}]` - answers nothing, but it runs and returns a
 * thousand unrelated documents as if they were the answer. A hosted model produced exactly that
 * for "what is the weather in Paris tomorrow" while its own prose said the question was impossible.
 * The SQL path already rejects the equivalent dodge (`SELECT 'canned reply'`).
 */
import { describe, expect, it, vi } from 'vitest';
import { createMongoAskSql, type MongoConnector } from '../src/mongo/index.js';
import type { CustomModel, ExecuteOptions, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'mongodb',
  schemas: ['shop'],
  tables: [
    {
      name: 'orders',
      kind: 'table',
      columns: [
        { name: '_id', dbType: 'objectId', nullable: false },
        { name: 'status', dbType: 'string', nullable: true },
      ],
      primaryKey: ['_id'],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
    },
  ],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
};

const RESULT: ResultSet = { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1, warnings: [] };

class FakeMongo implements MongoConnector {
  readonly id = 'm';
  readonly name = 'Shop Mongo';
  readonly engine = 'mongodb' as const;
  readonly database = 'shop';
  connect = vi.fn(async () => {});
  close = vi.fn(async () => {});
  async introspect(): Promise<SchemaCatalog> {
    return CATALOG;
  }
  async aggregate(_collection: string, _pipeline: unknown[], _opts?: ExecuteOptions): Promise<ResultSet> {
    return RESULT;
  }
}

const model =
  (reply: string): CustomModel =>
  async () =>
    reply;
const fenced = (pipeline: string) => '```js\ndb.orders.aggregate(' + pipeline + ')\n```';
/** Word for word the shape a hosted model produced: a slice-only pipeline plus a prose admission. */
const dodge = (pipeline: string) =>
  fenced(pipeline) +
  "\n\nThe provided schema does not contain any information about the weather, so it's impossible to answer this question using the given schema. The pipeline above is a minimal valid pipeline.";

describe('a pipeline that selects nothing is not an answer', () => {
  for (const [label, pipeline] of [
    ['$limit alone', '[{"$limit": 1000}]'],
    ['$skip and $limit', '[{"$skip": 0}, {"$limit": 50}]'],
    ['$sort and $limit', '[{"$sort": {"_id": 1}}, {"$limit": 10}]'],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const engine = createMongoAskSql({ connector: new FakeMongo(), model: model(dodge(pipeline)) });
      await expect(engine.ask('what is the weather in Paris tomorrow')).rejects.toMatchObject({
        code: 'LLM_BAD_OUTPUT',
      });
    });
  }

  it('rejects the same dodge written as shell JSON, which is what a small model emits', async () => {
    // Unquoted keys parse only after the guard relaxes them. Reading this check with plain
    // JSON.parse left it silently off for every shell-form pipeline.
    const engine = createMongoAskSql({ connector: new FakeMongo(), model: model(dodge('[{$limit: 1000}]')) });
    await expect(engine.ask('what is the weather in Paris tomorrow')).rejects.toMatchObject({
      code: 'LLM_BAD_OUTPUT',
    });
  });

  it('accepts a pipeline that groups', async () => {
    const engine = createMongoAskSql({
      connector: new FakeMongo(),
      model: model(fenced('[{"$group": {"_id": "$status", "n": {"$sum": 1}}}, {"$limit": 1000}]')),
    });
    const result = await engine.ask('how many orders per status');
    expect(result.pipelineJson).toContain('$group');
  });

  it('accepts a slice-only pipeline when the model is not dodging', async () => {
    // "show me 50 orders" is genuinely answered by a $limit, so the shape alone proves nothing.
    const engine = createMongoAskSql({ connector: new FakeMongo(), model: model(fenced('[{"$limit": 50}]')) });
    const result = await engine.ask('show me 50 orders');
    expect(result.pipelineJson).toContain('$limit');
  });

  it('accepts a pipeline that only filters', async () => {
    const engine = createMongoAskSql({
      connector: new FakeMongo(),
      model: model(fenced('[{"$match": {"status": "paid"}}, {"$limit": 1000}]')),
    });
    const result = await engine.ask('show me the paid orders');
    expect(result.pipelineJson).toContain('$match');
  });
});
