/**
 * MongoDB engine hardening: $lookup/$graphLookup/$unionWith join targets are
 * resolved and case-corrected against the catalog (M3), and the catalog cache
 * refuses empty-with-warnings results and short-TTLs warned ones (M7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongoAskSql, type MongoConnector } from '../src/mongo/index.js';
import type { CustomModel, ExecuteOptions, ResultSet, SchemaCatalog, TableInfo } from '../src/types.js';

const table = (name: string): TableInfo => ({
  name,
  kind: 'table',
  columns: [{ name: '_id', dbType: 'objectId', nullable: false }],
  primaryKey: ['_id'],
  foreignKeys: [],
  uniques: [],
  checks: [],
  indexes: [],
});

const catalogOf = (tables: TableInfo[], warnings: string[] = []): SchemaCatalog => ({
  engine: 'mongodb',
  schemas: ['shop'],
  tables,
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings,
  fetchedAt: 'now',
});

const RESULT: ResultSet = { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1, warnings: [] };

class FakeMongo implements MongoConnector {
  readonly id = 'm';
  readonly name = 'Shop Mongo';
  readonly engine = 'mongodb' as const;
  readonly database = 'shop';
  aggregateCalls: { collection: string; pipeline: unknown[] }[] = [];
  connect = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor(private cat: SchemaCatalog) {}
  async introspect(): Promise<SchemaCatalog> {
    return this.cat;
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

describe('M3 join-target resolution and case correction', () => {
  it('rewrites a wrong-cased $lookup `from` to the real collection casing', async () => {
    const conn = new FakeMongo(catalogOf([table('orders'), table('customers')]));
    const engine = createMongoAskSql({
      connector: conn,
      model: model([
        '```js\ndb.orders.aggregate([{"$lookup": {"from": "Customers", "localField": "cid", "foreignField": "_id", "as": "c"}}])\n```\njoin',
      ]),
    });
    const res = await engine.ask('orders with customers');
    const stages = JSON.parse(res.pipelineJson) as Record<string, { from?: string }>[];
    expect(stages[0]!['$lookup']!.from).toBe('customers');
  });

  it('rejects a hallucinated join target that does not exist', async () => {
    const conn = new FakeMongo(catalogOf([table('orders')]));
    const engine = createMongoAskSql({
      connector: conn,
      model: model(['```js\ndb.orders.aggregate([{"$lookup": {"from": "invoices", "as": "j"}}])\n```']),
    });
    await expect(engine.ask('orders with invoices')).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
  });

  it('case-corrects a $unionWith target at execute and rejects an unknown one', async () => {
    const conn = new FakeMongo(catalogOf([table('orders'), table('archive')]));
    const engine = createMongoAskSql({ connector: conn, model: model(['']) });
    await engine.execute('[{"$unionWith": "Archive"}]', 'orders');
    const pipeline = conn.aggregateCalls[0]!.pipeline as Record<string, string>[];
    expect(pipeline[0]!['$unionWith']).toBe('archive');
    await expect(engine.execute('[{"$unionWith": "ghost"}]', 'orders')).rejects.toMatchObject({
      code: 'DB_QUERY_ERROR',
    });
  });
});

describe('M7 warning-aware catalog cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refuses to cache an empty catalog carrying warnings and retries next time', async () => {
    const conn = new FakeMongo(catalogOf([], ['sample failed on orders']));
    const spy = vi.spyOn(conn, 'introspect');
    const engine = createMongoAskSql({ connector: conn, model: model(['']) });
    await expect(engine.catalog()).rejects.toMatchObject({ code: 'DB_QUERY_ERROR' });
    await expect(engine.catalog()).rejects.toMatchObject({ code: 'DB_QUERY_ERROR' });
    expect(spy).toHaveBeenCalledTimes(2); // never cached, re-introspected
  });

  it('short-TTLs a warned-but-nonempty catalog', async () => {
    const conn = new FakeMongo(catalogOf([table('orders')], ['sample failed on other']));
    const spy = vi.spyOn(conn, 'introspect');
    const engine = createMongoAskSql({ connector: conn, model: model(['']) });
    await engine.catalog();
    vi.advanceTimersByTime(31_000); // past the 30s warned TTL
    await engine.catalog();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('full-TTLs a clean catalog with no warnings', async () => {
    const conn = new FakeMongo(catalogOf([table('orders')]));
    const spy = vi.spyOn(conn, 'introspect');
    const engine = createMongoAskSql({ connector: conn, model: model(['']) });
    await engine.catalog();
    vi.advanceTimersByTime(31_000); // still within the 5m clean TTL
    await engine.catalog();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
