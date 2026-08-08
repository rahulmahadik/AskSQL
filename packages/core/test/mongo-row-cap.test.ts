/** MongoDB rejects a $limit that is not a positive integer. */
import { describe, expect, it, vi } from 'vitest';
import { createMongoAskSql, guardPipeline, resolveMongoGuardPolicy, type MongoConnector } from '../src/mongo/index.js';
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
  async aggregate(_c: string, _p: unknown[], _o?: ExecuteOptions): Promise<ResultSet> {
    return RESULT;
  }
}

const model =
  (reply: string): CustomModel =>
  async () =>
    reply;

/** `requested` as configured -> the only $limit MongoDB may legally be sent. */
const CASES: { label: string; requested: number | undefined; expected: number }[] = [
  { label: 'fractional 12.5 floors to an integer', requested: 12.5, expected: 12 },
  { label: 'zero falls back to the default', requested: 0, expected: 1000 },
  { label: 'negative falls back to the default', requested: -5, expected: 1000 },
  { label: 'absurd 200000 is capped', requested: 200_000, expected: 100_000 },
  { label: 'missing value falls back to the default', requested: undefined, expected: 1000 },
  { label: 'NaN falls back to the default', requested: Number.NaN, expected: 1000 },
  { label: 'Infinity falls back to the default', requested: Number.POSITIVE_INFINITY, expected: 1000 },
];

const lastLimit = (pipelineJson: string): unknown => {
  const stages = JSON.parse(pipelineJson) as Record<string, unknown>[];
  return stages[stages.length - 1]?.['$limit'];
};

describe('mongo row cap clamp', () => {
  for (const { label, requested, expected } of CASES) {
    it(`resolveMongoGuardPolicy: ${label}`, () => {
      const policy = resolveMongoGuardPolicy(requested === undefined ? {} : { maxRows: requested });
      expect(policy.maxRows).toBe(expected);
      expect(Number.isInteger(policy.maxRows)).toBe(true);
      expect(policy.maxRows).toBeGreaterThan(0);
    });

    it(`guardPipeline injects the clamped $limit: ${label}`, () => {
      const policy = resolveMongoGuardPolicy({ maxDepth: 400, maxRegexPatternLength: 200 });
      const v = guardPipeline('[{"$match":{}}]', {
        ...policy,
        ...(requested === undefined ? {} : { maxRows: requested }),
      });
      expect(v.allowed).toBe(true);
      const limit = lastLimit(v.pipelineJson);
      expect(limit).toBe(expected);
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit as number).toBeGreaterThan(0);
    });

    it(`engine ask injects the clamped $limit and names it in the warning: ${label}`, async () => {
      const engine = createMongoAskSql({
        connector: new FakeMongo(),
        model: model('```js\ndb.orders.aggregate([{"$match": {"status": "paid"}}])\n```\nPaid orders.'),
        ...(requested === undefined ? {} : { policy: { maxRows: requested } }),
      });
      const res = await engine.ask('paid orders');
      const limit = lastLimit(res.pipelineJson);
      expect(limit).toBe(expected);
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit as number).toBeGreaterThan(0);
      expect(res.autoLimited).toBe(true);
      expect(res.warnings.join(' ')).toContain(`A row limit of ${expected} was added automatically`);
    });
  }

  it('an over-large trailing $limit is lowered to the clamped cap, not the raw setting', () => {
    const v = guardPipeline('[{"$match":{}},{"$limit":9999999}]', { ...resolveMongoGuardPolicy({}), maxRows: 200_000 });
    expect(v.loweredLimit).toBe(true);
    expect(lastLimit(v.pipelineJson)).toBe(100_000);
  });
});
