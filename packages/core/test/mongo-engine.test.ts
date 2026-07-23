/**
 * MongoDB engine tests with a deterministic mock model + fake connector - no
 * network. Exercises ask -> extract -> guard -> execute, the repair loop, the
 * collection-existence floor, auto-limit, and explain.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMongoAskSql, type MongoConnector } from '../src/mongo/index.js';
import { AskSqlError } from '../src/errors.js';
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
        { name: 'total', dbType: 'int32', nullable: false },
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
  aggregateCalls: { collection: string; pipeline: unknown[] }[] = [];
  connect = vi.fn(async () => {});
  close = vi.fn(async () => {});
  async introspect(): Promise<SchemaCatalog> {
    return CATALOG;
  }
  async aggregate(collection: string, pipeline: unknown[], _opts?: ExecuteOptions): Promise<ResultSet> {
    this.aggregateCalls.push({ collection, pipeline });
    return RESULT;
  }
}

const model = (replies: string[]): CustomModel => {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)]!;
};

describe('mongo engine happy path', () => {
  it('ask returns a guarded pipeline, collection, and explanation', async () => {
    const conn = new FakeMongo();
    const engine = createMongoAskSql({
      connector: conn,
      model: model(['```js\ndb.orders.aggregate([{"$match": {"status": "paid"}}])\n```\nPaid orders.']),
      policy: { maxRows: 50, maxDepth: 400, maxRegexPatternLength: 200 },
    });
    const res = await engine.ask('paid orders');
    expect(res.collection).toBe('orders');
    expect(res.explanation).toMatch(/paid orders/i);
    expect(res.autoLimited).toBe(true); // no $limit -> injected
    expect(JSON.parse(res.pipelineJson)).toEqual([{ $match: { status: 'paid' } }, { $limit: 50 }]);
  });

  it('execute re-guards and runs the pipeline against the resolved collection', async () => {
    const conn = new FakeMongo();
    const engine = createMongoAskSql({ connector: conn, model: model(['']) });
    const out = await engine.execute('[{"$match": {}}]', 'ORDERS'); // wrong case resolves
    expect(out).toEqual(RESULT);
    expect(conn.aggregateCalls[0]!.collection).toBe('orders');
  });
});

describe('mongo engine floors and repair', () => {
  it('repairs a rejected pipeline, then blocks after repairs are exhausted', async () => {
    const conn = new FakeMongo();
    const engine = createMongoAskSql({
      // $out is a write stage; never allowed, so every attempt is rejected.
      connector: conn,
      model: model(['```js\ndb.orders.aggregate([{"$out": "evil"}])\n```']),
    });
    await expect(engine.ask('dump orders')).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
  });

  it('rejects an unknown collection after repairs', async () => {
    const conn = new FakeMongo();
    const engine = createMongoAskSql({
      connector: conn,
      model: model(['```js\ndb.customers.aggregate([{"$match": {}}])\n```']),
    });
    await expect(engine.ask('all customers')).rejects.toBeInstanceOf(AskSqlError);
  });

  it('surfaces the IMPOSSIBLE sentinel as a friendly error', async () => {
    const conn = new FakeMongo();
    const engine = createMongoAskSql({
      connector: conn,
      model: model(['IMPOSSIBLE: there is no weather data in this database']),
    });
    await expect(engine.ask('what is the weather')).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
  });
});

describe('mongo engine explain', () => {
  it('guards the pipeline first, then returns the model explanation', async () => {
    const conn = new FakeMongo();
    const engine = createMongoAskSql({ connector: conn, model: model(['This counts paid orders.']) });
    const text = await engine.explain('[{"$match": {"status": "paid"}}]');
    expect(text).toMatch(/counts paid orders/i);
  });

  it('refuses to explain a disallowed pipeline', async () => {
    const conn = new FakeMongo();
    const engine = createMongoAskSql({ connector: conn, model: model(['ignored']) });
    await expect(engine.explain('[{"$out": "x"}]')).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
  });
});

describe('mongo engine branch coverage', () => {
  it('rejects an empty and an over-long question', async () => {
    const engine = createMongoAskSql({ connector: new FakeMongo(), model: model(['']) });
    await expect(engine.ask('   ')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(engine.ask('x'.repeat(10_001))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('surfaces a plain refusal as LLM_REFUSAL', async () => {
    const engine = createMongoAskSql({
      connector: new FakeMongo(),
      model: model(["I'm sorry, I can't help with that request."]),
    });
    await expect(engine.ask('do something')).rejects.toMatchObject({ code: 'LLM_REFUSAL' });
  });

  it('repairs a guard-blocked pipeline then succeeds', async () => {
    const conn = new FakeMongo();
    const engine = createMongoAskSql({
      connector: conn,
      model: model([
        '```js\ndb.orders.aggregate([{"$out": "evil"}])\n```', // blocked
        '```js\ndb.orders.aggregate([{"$match": {"status": "paid"}}])\n```\nok', // valid
      ]),
      policy: { maxRows: 50, maxDepth: 400, maxRegexPatternLength: 200 },
    });
    const res = await engine.ask('paid orders');
    expect(res.repairs).toBeGreaterThanOrEqual(1);
    expect(res.collection).toBe('orders');
  });

  it('lowers an over-large $limit and warns', async () => {
    const engine = createMongoAskSql({
      connector: new FakeMongo(),
      model: model(['```js\ndb.orders.aggregate([{"$limit": 9999}])\n```']),
      policy: { maxRows: 50, maxDepth: 400, maxRegexPatternLength: 200 },
    });
    const res = await engine.ask('orders');
    expect(res.loweredLimit).toBe(true);
    expect(res.warnings.some((w) => /lowered/i.test(w))).toBe(true);
  });

  it('caches the catalog across asks', async () => {
    const conn = new FakeMongo();
    const spy = vi.spyOn(conn, 'introspect');
    const engine = createMongoAskSql({
      connector: conn,
      model: model(['```js\ndb.orders.aggregate([{"$match": {}}])\n```']),
    });
    await engine.ask('one');
    await engine.ask('two');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
