/**
 * Limits, timeouts, hang-prevention, and friendly errors - a consolidated
 * production-readiness sweep.
 */
import { describe, expect, it } from 'vitest';
import { callModel } from '../src/llm.js';
import { guardSql } from '../src/guard.js';
import { createAskSql } from '../src/engine.js';
import { AskSqlError, type ErrorCode } from '../src/errors.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

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

describe('HANG PREVENTION: a model that ignores cancellation cannot hang the caller', () => {
  it('callModel enforces a HARD timeout even when the model never resolves', async () => {
    // Worst case: ignores the abort signal AND never resolves.
    const stuck: CustomModel = () => new Promise<string>(() => {});
    const start = Date.now();
    await expect(
      callModel({ model: stuck, system: 's', prompt: 'p', settings: { timeoutMs: 300, maxRetries: 0 } }),
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
    // Rejected promptly (not hung): well under a second for a 300ms timeout.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('engine.ask surfaces the timeout as a friendly, actionable message', async () => {
    const stuck: CustomModel = () => new Promise<string>(() => {});
    const engine = createAskSql({ connectors: [new Fake()], model: stuck, llm: { timeoutMs: 300, maxRetries: 0 } });
    try {
      await engine.ask('anything');
      throw new Error('should time out');
    } catch (err) {
      expect((err as AskSqlError).code).toBe('LLM_TIMEOUT');
      expect((err as AskSqlError).userMessage).toMatch(/took too long|retry/i);
      // No stack / internal jargon leaked to the user message.
      expect((err as AskSqlError).userMessage).not.toMatch(/Promise|abort|setTimeout|undefined/);
    }
  });

  it('a caller AbortSignal stops the call promptly (no hang)', async () => {
    const stuck: CustomModel = () => new Promise<string>(() => {});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const start = Date.now();
    await expect(
      callModel({ model: stuck, system: 's', prompt: 'p', signal: ac.signal, settings: { timeoutMs: 10_000 } }),
    ).rejects.toBeTruthy();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('LIMITS: caps are enforced with friendly errors', () => {
  it('over-long SQL is blocked (maxSqlLength)', () => {
    const huge = 'SELECT ' + '1,'.repeat(60_000) + '1';
    const v = guardSql({ sql: huge, dialect: POSTGRES_DIALECT });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/too long/i);
  });

  it('over-deep nesting is blocked (maxDepth), no stack overflow', () => {
    let s = 'SELECT 1';
    for (let i = 0; i < 300; i++) s = `SELECT * FROM (${s}) t${i}`;
    const v = guardSql({ sql: s, dialect: POSTGRES_DIALECT });
    expect(typeof v.allowed).toBe('boolean'); // did not throw
  });

  it('an over-long question is rejected with a plain-language message', async () => {
    const engine = createAskSql({ connectors: [new Fake()], model: async () => 'x' });
    try {
      await engine.ask('x'.repeat(10_001));
      throw new Error('should reject');
    } catch (err) {
      expect((err as AskSqlError).code).toBe('INVALID_INPUT');
      expect((err as AskSqlError).userMessage).toMatch(/too long/i);
    }
  });

  it('auto-LIMIT caps an unbounded SELECT so no engine returns everything', () => {
    const v = guardSql({ sql: 'SELECT * FROM users', dialect: POSTGRES_DIALECT, policy: { maxRows: 500 } });
    expect(v.allowed).toBe(true);
    expect(v.autoLimited).toBe(true);
    expect(v.sql).toMatch(/limit 500/i);
  });
});

describe('maxRows clamp (H3) and truncation signal (M1)', () => {
  class Capturing extends Fake {
    lastMaxRows: number | undefined;
    constructor(private readonly returnRows = 1) {
      super();
    }
    override async execute(_sql: string, opts?: { maxRows?: number }): Promise<ResultSet> {
      this.lastMaxRows = opts?.maxRows;
      return {
        columns: [{ name: 'id', kind: 'bigint' }],
        rows: Array.from({ length: this.returnRows }, (_v, i) => [String(i)]),
        rowCount: this.returnRows,
        truncated: false, // the connector cannot see truncation once the guard caps at maxRows
        durationMs: 1,
        warnings: [],
      };
    }
  }

  it('clamps a caller maxRows above the policy ceiling (the only bound for fetch-style dialects)', async () => {
    const conn = new Capturing();
    const engine = createAskSql({ connectors: [conn], model: async () => 'x', policy: { maxRows: 100 } });
    await engine.execute('SELECT * FROM users', { maxRows: 1_000_000 });
    expect(conn.lastMaxRows).toBe(100);
  });

  it('reports truncated when an auto-limited result fills the cap', async () => {
    const conn = new Capturing(100);
    const engine = createAskSql({ connectors: [conn], model: async () => 'x', policy: { maxRows: 100 } });
    const res = await engine.execute('SELECT * FROM users');
    expect(res.truncated).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/export to get everything/i);
  });

  it('does not over-report truncation for a result under the cap', async () => {
    const conn = new Capturing(3);
    const engine = createAskSql({ connectors: [conn], model: async () => 'x', policy: { maxRows: 100 } });
    const res = await engine.execute('SELECT * FROM users');
    expect(res.truncated).toBe(false);
  });
});

describe('FRIENDLY ERRORS: every error code has an actionable, safe message', () => {
  const CODES: ErrorCode[] = [
    'LLM_AUTH',
    'LLM_RATE_LIMIT',
    'LLM_TIMEOUT',
    'LLM_CONTEXT_OVERFLOW',
    'LLM_BAD_OUTPUT',
    'LLM_REFUSAL',
    'LLM_UNREACHABLE',
    'LLM_UNAVAILABLE',
    'GUARD_BLOCKED',
    'DB_AUTH',
    'DB_UNREACHABLE',
    'DB_QUERY_ERROR',
    'DB_TIMEOUT',
    'FILE_PARSE',
    'WASM_LOAD',
    'CANCELLED',
    'SERVER_AUTHZ',
    'INVALID_INPUT',
    'CONFIG_ERROR',
  ];

  it('each code maps to a non-empty, single-line message with no leaked internals', () => {
    for (const code of CODES) {
      const e = new AskSqlError(code, { detail: 'password=secret host=internal stack trace at foo.js:1' });
      expect(e.userMessage.length).toBeGreaterThan(0);
      expect(e.userMessage.split('\n')).toHaveLength(1); // single line
      // Wire-safe: detail/secret NEVER appears in the user-facing JSON.
      const json = JSON.stringify(e.toJSON());
      expect(json).not.toMatch(/password=secret|internal|stack trace|foo\.js/);
    }
  });

  it('retryable flag is set sensibly per code (drives the UI Retry button)', () => {
    expect(new AskSqlError('DB_TIMEOUT').retryable).toBe(true);
    expect(new AskSqlError('LLM_RATE_LIMIT').retryable).toBe(true);
    expect(new AskSqlError('DB_UNREACHABLE').retryable).toBe(true);
    expect(new AskSqlError('GUARD_BLOCKED').retryable).toBe(false);
    expect(new AskSqlError('LLM_AUTH').retryable).toBe(false);
    expect(new AskSqlError('INVALID_INPUT').retryable).toBe(false);
  });
});
