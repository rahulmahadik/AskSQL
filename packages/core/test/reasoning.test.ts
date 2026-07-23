/**
 * reasoning models: long silent "thinking" before output. Real
 * reasoning models (o-series / gpt-5) need a reasoning key to run live; here
 * we simulate the behavior with a model that delays its first output, and
 * assert the engine (a) stays in the generating stage (a "thinking" indicator,
 * not a stall), (b) succeeds when the timeout is generous, and (c) surfaces a
 * friendly LLM_TIMEOUT when the wait exceeds the budget.
 */
import { describe, expect, it } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { AskSqlError } from '../src/errors.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, EngineEvent, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'users',
      kind: 'table',
      columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
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
      columns: [{ name: 'id', kind: 'bigint' }],
      rows: [['1']],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
      warnings: [],
    };
  }
}

/** A "reasoning" model: silent thinking, then emits SQL. */
const thinkingModel =
  (thinkMs: number): CustomModel =>
  async () => {
    await new Promise((r) => setTimeout(r, thinkMs));
    return '```sql\nSELECT count(*) FROM users\n```\nAfter careful thought.';
  };

describe('reasoning / long-thinking model', () => {
  it('shows a generating stage during the silent think, then completes', async () => {
    const stages: string[] = [];
    const engine = createAskSql({
      connectors: [new Fake()],
      model: thinkingModel(400),
      llm: { timeoutMs: 5000 },
      onEvent: (e: EngineEvent) => {
        if (e.type === 'stage') stages.push(e.stage);
      },
    });
    const ans = await engine.ask('how many users?');
    expect(ans.sql).toMatch(/count\(\*\)/i);
    // The 'llm' stage (the "Writing SQL.../thinking" indicator) was emitted -
    // the UI shows progress, not a frozen screen, during the think.
    expect(stages).toContain('llm');
  });

  it('a generous timeout accommodates a long think', async () => {
    const engine = createAskSql({ connectors: [new Fake()], model: thinkingModel(800), llm: { timeoutMs: 5000 } });
    const ans = await engine.ask('count users');
    expect(ans.sql).toBeTruthy();
  });

  it('a think that exceeds the budget yields a friendly LLM_TIMEOUT', async () => {
    const engine = createAskSql({
      connectors: [new Fake()],
      model: thinkingModel(2000),
      llm: { timeoutMs: 300, maxRetries: 0 },
    });
    try {
      await engine.ask('count users');
      throw new Error('should time out');
    } catch (err) {
      expect((err as AskSqlError).code).toBe('LLM_TIMEOUT');
      expect((err as AskSqlError).userMessage).toMatch(/took too long|retry/i);
    }
  });
});
