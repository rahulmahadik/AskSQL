/**
 * Boundary tests for the engine pipeline: repair-loop exhaustion shapes, cancellation at
 * each stage (and what error code the caller sees), history-store failure isolation, and
 * degenerate model output (empty, whitespace, fence-only).
 */
import { describe, expect, it } from 'vitest';
import { createAskSql, redactValuesInError } from '../src/engine.js';
import { AskSqlError } from '../src/errors.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type {
  Connector,
  CustomModel,
  ExecuteOptions,
  HistoryEntry,
  HistoryPage,
  HistoryStore,
  ResultSet,
  SchemaCatalog,
} from '../src/types.js';

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
  executed: string[] = [];
  constructor(private readonly onExecute?: (sql: string, opts?: ExecuteOptions) => ResultSet | Promise<ResultSet>) {}
  async connect() {}
  async close() {}
  async introspect() {
    return CATALOG;
  }
  async execute(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    this.executed.push(sql);
    if (this.onExecute) return this.onExecute(sql, opts);
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

/** Counting model: always replies with the same text, records how often it was invoked. */
const countingModel = (reply: string): CustomModel & { calls: () => number } => {
  let n = 0;
  const fn = (async () => {
    n += 1;
    return reply;
  }) as CustomModel & { calls: () => number };
  fn.calls = () => n;
  return fn;
};

describe('repair-loop exhaustion shapes', () => {
  it('a model that returns the same guard-blocked SQL forever stops after MAX_REPAIRS+1 calls', async () => {
    const m = countingModel('```sql\nDELETE FROM users\n```');
    const engine = createAskSql({ connectors: [new FakeConnector()], model: m });
    await expect(engine.ask('list the users')).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    // 1 initial + MAX_REPAIRS(2) repairs; a 4th call would mean the loop leaked.
    expect(m.calls()).toBe(3);
    const hist = await engine.history.list('fake');
    expect(hist.items[0]!.status).toBe('blocked');
  });

  it('a model that returns only whitespace on every attempt maps to LLM_UNAVAILABLE (unreachable model)', async () => {
    const m = countingModel('  \n\t ');
    const engine = createAskSql({ connectors: [new FakeConnector()], model: m });
    const err = await engine.ask('list users').catch((e: AskSqlError) => e);
    expect(AskSqlError.is(err)).toBe(true);
    expect((err as AskSqlError).code).toBe('LLM_UNAVAILABLE');
    expect((err as AskSqlError).userMessage).toMatch(/empty response/i);
    expect(m.calls()).toBe(3);
  });

  it('a model that returns only an empty fence is bad output, NOT an unreachable model', async () => {
    // The reply is non-empty text, so the "model returned nothing" diagnosis would be wrong.
    const m = countingModel('```sql\n```');
    const engine = createAskSql({ connectors: [new FakeConnector()], model: m });
    const err = await engine.ask('list users').catch((e: AskSqlError) => e);
    expect((err as AskSqlError).code).toBe('LLM_BAD_OUTPUT');
  });

  it('one empty reply followed by SQL consumes exactly one repair', async () => {
    let i = 0;
    const replies = ['', '```sql\nSELECT name FROM users\n```'];
    const m: CustomModel = async () => replies[Math.min(i++, replies.length - 1)]!;
    const engine = createAskSql({ connectors: [new FakeConnector()], model: m });
    const res = await engine.ask('names');
    expect(res.sql).toMatch(/SELECT name FROM users/i);
    expect(res.repairs).toBe(1);
  });

  it('a literal-string answer with no table fails fast without burning repairs', async () => {
    const m = countingModel("```sql\nSELECT 'there are no users' AS answer\n```");
    const engine = createAskSql({ connectors: [new FakeConnector()], model: m });
    await expect(engine.ask('are there users?')).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
    expect(m.calls()).toBe(1);
  });
});

describe('cancellation boundaries', () => {
  it('an already-aborted signal never invokes the model at all', async () => {
    const ac = new AbortController();
    ac.abort();
    const m = countingModel('```sql\nSELECT name FROM users\n```');
    const engine = createAskSql({ connectors: [new FakeConnector()], model: m });
    await expect(engine.ask('names', { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    // The provider request must not fire after the user cancelled.
    expect(m.calls()).toBe(0);
  });

  it('abort during execute surfaces CANCELLED even when the connector throws a raw AbortError', async () => {
    // Third-party connectors reject with the driver's plain AbortError, not AskSqlError('CANCELLED').
    const ac = new AbortController();
    const conn = new FakeConnector(async (_sql, opts) => {
      ac.abort();
      expect(opts?.signal?.aborted).toBe(true);
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    const engine = createAskSql({ connectors: [conn], model: countingModel('```sql\nSELECT name FROM users\n```') });
    const res = await engine.ask('names');
    const err = await res.run({ signal: ac.signal }).catch((e: AskSqlError) => e);
    expect(AskSqlError.is(err)).toBe(true);
    // "The query failed to run" is the wrong story for a user-initiated cancel.
    expect((err as AskSqlError).code).toBe('CANCELLED');
  });

  it('a cancelled run() never makes a post-cancel LLM repair call', async () => {
    const ac = new AbortController();
    const conn = new FakeConnector(async () => {
      ac.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    const m = countingModel('```sql\nSELECT name FROM users\n```');
    const engine = createAskSql({ connectors: [conn], model: m });
    const res = await engine.ask('names');
    const callsAfterAsk = m.calls();
    await res.run({ signal: ac.signal }).catch(() => undefined);
    // tryRepairAfterDbError must not fire a provider request for a query the user cancelled.
    expect(m.calls()).toBe(callsAfterAsk);
  });

  it('abort mid-stream in a streaming custom model maps to CANCELLED', async () => {
    const ac = new AbortController();
    const m: CustomModel = async () => {
      async function* stream() {
        yield '```sql\nSELECT';
        ac.abort();
        yield ' name FROM users\n```';
      }
      return stream();
    };
    const engine = createAskSql({ connectors: [new FakeConnector()], model: m });
    await expect(engine.ask('names', { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('history-store failure isolation', () => {
  class FailingHistory implements HistoryStore {
    async add(_entry: HistoryEntry): Promise<void> {
      throw new Error('history disk full');
    }
    async list(): Promise<HistoryPage> {
      return { items: [], total: 0 };
    }
  }

  it('a failing history store does not turn a successful query into an error', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: countingModel('x'),
      history: new FailingHistory(),
    });
    // The query ran and returned rows; a telemetry write must not discard them.
    const out = await engine.execute('SELECT name FROM users');
    expect(out.rowCount).toBe(1);
  });

  it('a failing history store does not mask a guard block (the caller still sees GUARD_BLOCKED)', async () => {
    const engine = createAskSql({
      connectors: [new FakeConnector()],
      model: countingModel('x'),
      history: new FailingHistory(),
    });
    const err = await engine.execute('DELETE FROM users').catch((e: unknown) => e);
    expect(AskSqlError.is(err)).toBe(true);
    expect((err as AskSqlError).code).toBe('GUARD_BLOCKED');
  });

  it('a failing history store does not mask the real DB error', async () => {
    const conn = new FakeConnector(() => {
      throw new AskSqlError('DB_QUERY_ERROR', { userMessage: 'division by zero' });
    });
    const engine = createAskSql({
      connectors: [conn],
      model: countingModel('x'),
      history: new FailingHistory(),
    });
    const err = await engine.execute('SELECT 1 / 0 FROM users').catch((e: unknown) => e);
    expect(AskSqlError.is(err)).toBe(true);
    expect((err as AskSqlError).code).toBe('DB_QUERY_ERROR');
    expect((err as AskSqlError).userMessage).toMatch(/division by zero/);
  });
});

describe('question-length boundary', () => {
  it('exactly 10,000 characters is accepted; 10,001 is rejected', async () => {
    const engine = createAskSql({
      connectors: [new FakeConnector()],
      model: countingModel('```sql\nSELECT name FROM users\n```'),
    });
    const base = 'how many users are named ';
    const at = base + 'a'.repeat(10_000 - base.length);
    await expect(engine.ask(at)).resolves.toBeDefined();
    await expect(engine.ask(at + 'a')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('redactValuesInError', () => {
  it('strips the duplicate-key VALUE but keeps the constraint name', () => {
    const out = redactValuesInError(
      'duplicate key value violates unique constraint "users_email_key" Detail: Key (email)=(ada@example.com) already exists.',
    );
    expect(out).not.toContain('ada@example.com');
    expect(out).toContain('users_email_key');
  });

  it('strips a MySQL duplicate-entry value', () => {
    const out = redactValuesInError("Duplicate entry 'alice@example.com' for key 'users.uq_email'");
    expect(out).not.toContain('alice@example.com');
  });

  it('keeps identifiers the repair loop needs (unknown column phrasing)', () => {
    const out = redactValuesInError("Unknown column 'user_nam' in 'field list'");
    expect(out).toContain('user_nam');
  });

  it('strips values with parentheses inside without leaking the payload', () => {
    const out = redactValuesInError('Key (payload)=(secret(1)) already exists.');
    expect(out).not.toContain('secret');
  });
});
