/**
 * Branch coverage for createAskSql: config validation, catalog caching/TTL,
 * the repair loop (guard block, unknown-table/column floors), suggestFix, and
 * explain edge cases. Deterministic mock model + fake connector.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { AskSqlError } from '../src/errors.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'users',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'name', dbType: 'text', nullable: false },
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

function fakeConn(over: Partial<Connector> = {}): Connector {
  return {
    engine: 'postgres',
    dialect: POSTGRES_DIALECT,
    capabilities: {
      supportsCancel: true,
      supportsExplain: true,
      supportsSchemas: true,
      readOnlySession: true,
      supportsMatViews: true,
      supportsTriggers: true,
      supportsRoutines: true,
    },
    id: 'db',
    name: 'DB',
    async connect() {},
    async close() {},
    async introspect() {
      return CATALOG;
    },
    async execute(): Promise<ResultSet> {
      return {
        columns: [{ name: 'n', kind: 'number' }],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
        durationMs: 1,
        warnings: [],
      };
    },
    ...over,
  } as Connector;
}

const seqModel = (replies: string[]): CustomModel => {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)]!;
};
const model =
  (r: string): CustomModel =>
  async () =>
    r;

describe('createAskSql config validation', () => {
  const m = model('```sql\nSELECT 1\n```');
  it('rejects no connectors', () => expect(() => createAskSql({ connectors: [], model: m })).toThrow(/connectors/i));
  it('rejects a missing model', () =>
    expect(() => createAskSql({ connectors: [fakeConn()], model: undefined as never })).toThrow(/model/i));
  it('rejects an empty id', () =>
    expect(() => createAskSql({ connectors: [fakeConn({ id: '' })], model: m })).toThrow(/id/i));
  it('rejects an empty name', () =>
    expect(() => createAskSql({ connectors: [fakeConn({ name: '  ' })], model: m })).toThrow(/name/i));
  it('rejects duplicate ids', () =>
    expect(() => createAskSql({ connectors: [fakeConn(), fakeConn()], model: m })).toThrow(/duplicate/i));
});

describe('catalog caching', () => {
  it('caches within the TTL and refreshes on demand', async () => {
    const introspect = vi.fn(async () => CATALOG);
    const engine = createAskSql({ connectors: [fakeConn({ introspect })], model: model('x') });
    await engine.catalog('db');
    await engine.catalog('db'); // cached - no second introspect
    expect(introspect).toHaveBeenCalledTimes(1);
    await engine.catalog('db', { refresh: true }); // forced
    expect(introspect).toHaveBeenCalledTimes(2);
  });

  it('caches a warned catalog only briefly (short TTL path)', async () => {
    const warned: SchemaCatalog = { ...CATALOG, warnings: ['permission denied on one table'] };
    const introspect = vi.fn(async () => warned);
    const engine = createAskSql({ connectors: [fakeConn({ introspect })], model: model('x') });
    const c = await engine.catalog('db');
    expect(c.warnings.length).toBe(1);
    await engine.catalog('db'); // still within short TTL -> cached
    expect(introspect).toHaveBeenCalledTimes(1);
  });

  it('throws a clean error for an unknown connectionId', async () => {
    const engine = createAskSql({ connectors: [fakeConn()], model: model('x') });
    expect(() => engine.catalog('nope')).toThrow();
  });
});

describe('ask repair loop', () => {
  it('repairs a guard-blocked first attempt', async () => {
    const engine = createAskSql({
      connectors: [fakeConn()],
      model: seqModel(['```sql\nDELETE FROM users\n```', '```sql\nSELECT id FROM users\n```\nok']),
    });
    const a = await engine.ask('list ids');
    expect(a.sql).toMatch(/SELECT id FROM users/i);
    expect(a.repairs).toBeGreaterThanOrEqual(1);
  });

  it('repairs an unknown-table hallucination', async () => {
    const engine = createAskSql({
      connectors: [fakeConn()],
      model: seqModel(['```sql\nSELECT * FROM invoices\n```', '```sql\nSELECT * FROM users\n```\nok']),
    });
    const a = await engine.ask('show invoices');
    expect(a.sql).toMatch(/FROM users/i);
  });

  it('throws LLM_BAD_OUTPUT on IMPOSSIBLE', async () => {
    const engine = createAskSql({ connectors: [fakeConn()], model: model('IMPOSSIBLE: no such data') });
    await expect(engine.ask('unanswerable')).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
  });

  it('blocks a literal-string canned answer', async () => {
    const engine = createAskSql({
      connectors: [fakeConn()],
      model: model("```sql\nSELECT 'hello there' AS reply\n```"),
    });
    await expect(engine.ask('hi')).rejects.toBeInstanceOf(AskSqlError);
  });
});

describe('explain', () => {
  it('rejects empty input', async () => {
    const engine = createAskSql({ connectors: [fakeConn()], model: model('a plain explanation') });
    await expect(engine.explain('   ')).rejects.toThrow(/provide a sql/i);
  });
  it('blocks a non-read-only statement', async () => {
    const engine = createAskSql({ connectors: [fakeConn()], model: model('x') });
    await expect(engine.explain('DELETE FROM users')).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
  });
  it('explains a valid read-only query', async () => {
    const engine = createAskSql({ connectors: [fakeConn()], model: model('It selects one row.') });
    expect(await engine.explain('SELECT 1')).toContain('selects');
  });
});

describe('suggestFix', () => {
  it('returns null without the original question', async () => {
    const engine = createAskSql({ connectors: [fakeConn()], model: model('x') });
    expect(await engine.suggestFix('SELECT bad FROM users', {})).toBeNull();
  });
  it('returns a guarded, different corrected query', async () => {
    const engine = createAskSql({
      connectors: [fakeConn()],
      model: model('```sql\nSELECT name FROM users\n```'),
    });
    const fixed = await engine.suggestFix('SELECT nope FROM users', {
      question: 'names',
      errorDetail: 'no column nope',
    });
    expect(fixed).toMatch(/SELECT name FROM users/i);
  });
  it('returns null when the correction is not a safe read-only query', async () => {
    const engine = createAskSql({
      connectors: [fakeConn()],
      model: model('```sql\nDROP TABLE users\n```'),
    });
    expect(await engine.suggestFix('SELECT nope FROM users', { question: 'x' })).toBeNull();
  });
});
