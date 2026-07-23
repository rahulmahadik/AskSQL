/**
 * Engine pipeline tests with a deterministic mock model + fake connector -
 * no network. Exercises ask->guard->execute, the repair loop, the
 * hallucination floor, cancellation, and history recording.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { AskSqlError } from '../src/errors.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ExecuteOptions, ResultSet, SchemaCatalog } from '../src/types.js';

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
        { name: 'created_at', dbType: 'timestamptz', nullable: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
    {
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'user_id', dbType: 'bigint', nullable: false },
        { name: 'total_cents', dbType: 'bigint', nullable: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
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
  lastSql = '';
  executed: string[] = [];
  constructor(private readonly onExecute?: (sql: string) => ResultSet) {}
  async connect() {}
  async close() {}
  async introspect() {
    return CATALOG;
  }
  async execute(sql: string, _opts?: ExecuteOptions): Promise<ResultSet> {
    this.lastSql = sql;
    this.executed.push(sql);
    if (this.onExecute) return this.onExecute(sql);
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

const model = (replies: string[]): CustomModel => {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)]!;
};

describe('engine happy path', () => {
  it('ask -> sql + explanation, run executes guarded/capped SQL', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model(['```sql\nSELECT count(*) FROM orders\n```\nCounts all orders.']),
      policy: { maxRows: 50 },
    });
    const res = await engine.ask('how many orders?');
    expect(res.sql).toMatch(/SELECT count\(\*\) FROM orders/i);
    expect(res.explanation).toMatch(/counts all orders/i);
    expect(res.repairs).toBe(0);
    const out = await res.run();
    expect(out.rowCount).toBe(1);
    // count(*) has no LIMIT added? It has no limit but is a single aggregate;
    // auto-LIMIT still applies since we can't prove single-row - accept either.
    expect(conn.executed).toHaveLength(1);
  });

  it('records history for executed queries', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({ connectors: [conn], model: model(['```sql\nSELECT * FROM users\n```']) });
    const res = await engine.ask('list users');
    await res.run();
    const hist = await engine.history.list('fake');
    expect(hist.total).toBe(1);
    expect(hist.items[0]!.status).toBe('ok');
    expect(hist.items[0]!.question).toBe('list users');
  });
});

describe('repair loop', () => {
  it('recovers when the first reply has no SQL', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model(['I think you want some data.', '```sql\nSELECT name FROM users\n```']),
    });
    const res = await engine.ask('names please');
    expect(res.sql).toMatch(/SELECT name FROM users/i);
    expect(res.repairs).toBe(1);
  });

  it('repairs a guard-blocked statement', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model(['```sql\nDELETE FROM users\n```', '```sql\nSELECT * FROM users\n```']),
    });
    const res = await engine.ask('remove users then show them');
    expect(res.sql).toMatch(/SELECT \* FROM users/i);
    expect(res.repairs).toBe(1);
  });

  it('blocks after exhausting repairs on a write', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model(['```sql\nDROP TABLE users\n```']),
    });
    await expect(engine.ask('drop users')).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
  });
});

describe('hallucination floor', () => {
  it('repairs a query referencing an unknown table', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model(['```sql\nSELECT * FROM invoices\n```', '```sql\nSELECT * FROM orders\n```']),
    });
    const res = await engine.ask('show invoices');
    expect(res.sql).toMatch(/orders/);
    expect(res.repairs).toBe(1);
  });

  it('errors when the model keeps hallucinating', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model(['```sql\nSELECT * FROM ghosts\n```']),
    });
    await expect(engine.ask('show ghosts')).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
  });
});

describe('IMPOSSIBLE sentinel', () => {
  it('surfaces a clean unanswerable error', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model(['IMPOSSIBLE: there is no salary information in this schema']),
    });
    await expect(engine.ask('average salary?')).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
  });
});

describe('validation + cancellation', () => {
  it('empty question rejected', async () => {
    const engine = createAskSql({ connectors: [new FakeConnector()], model: model(['x']) });
    await expect(engine.ask('   ')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('aborted signal stops generation', async () => {
    const ac = new AbortController();
    const slow: CustomModel = async () => {
      ac.abort();
      throw new AskSqlError('CANCELLED');
    };
    const engine = createAskSql({ connectors: [new FakeConnector()], model: slow });
    await expect(engine.ask('anything', { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('duplicate connector ids rejected at config', () => {
    expect(() =>
      createAskSql({ connectors: [new FakeConnector(), new FakeConnector()], model: model(['x']) }),
    ).toThrow();
  });

  it('direct execute of a write is blocked and recorded', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({ connectors: [conn], model: model(['x']) });
    await expect(engine.execute('DELETE FROM users')).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    const hist = await engine.history.list('fake');
    expect(hist.items[0]!.status).toBe('blocked');
  });
});

describe('DB-error auto-repair suggestion', () => {
  it('attaches a corrected query to the error without executing it', async () => {
    // Connector fails when the SQL references a non-existent column, succeeds
    // otherwise. The model first emits the bad column, then a good one.
    // A runtime error the hallucination floor cannot see (division by zero on
    // valid columns), so it reaches the DB and the suggestFix path runs.
    const conn = new FakeConnector((sql) => {
      if (/1 \/ 0|1\/0/.test(sql)) throw new AskSqlError('DB_QUERY_ERROR', { userMessage: 'division by zero' });
      return {
        columns: [{ name: 'id', kind: 'number' }],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
        durationMs: 1,
        warnings: [],
      };
    });
    const engine = createAskSql({
      connectors: [conn],
      model: model(['```sql\nSELECT 1 / 0 AS x FROM users\n```', '```sql\nSELECT id FROM users\n```']),
    });
    const ans = await engine.ask('give me the thing');
    expect(ans.sql).toMatch(/1 \/ 0/); // first attempt passed guard + column floor
    let caught: unknown;
    try {
      await ans.run();
    } catch (err) {
      caught = err;
    }
    expect(AskSqlError.is(caught)).toBe(true);
    expect((caught as AskSqlError).code).toBe('DB_QUERY_ERROR');
    // The corrected query is attached for re-approval - NOT auto-executed.
    const suggestion = (caught as AskSqlError & { suggestedSql?: string }).suggestedSql;
    expect(suggestion).toMatch(/SELECT id FROM users/i);
    // And the connector never ran the corrected SQL on its own.
    expect(conn.executed.some((s) => /SELECT id FROM users/i.test(s))).toBe(false);
  });
});

describe('connector recovers after a query error', () => {
  it('a failed query does not poison subsequent queries', async () => {
    let calls = 0;
    const conn = new FakeConnector((sql) => {
      calls++;
      if (/boom/.test(sql)) throw new AskSqlError('DB_QUERY_ERROR', { userMessage: 'boom' });
      return {
        columns: [{ name: 'n', kind: 'number' }],
        rows: [[calls]],
        rowCount: 1,
        truncated: false,
        durationMs: 1,
        warnings: [],
      };
    });
    const engine = createAskSql({ connectors: [conn], model: model(['x']) });
    await expect(engine.execute('SELECT boom FROM users')).rejects.toMatchObject({ code: 'DB_QUERY_ERROR' });
    // Next query still works.
    const ok = await engine.execute('SELECT ok FROM users');
    expect(ok.rowCount).toBe(1);
  });
});

describe('introspection masking', () => {
  class MaskingConnector extends FakeConnector {
    constructor(private readonly catalog: () => Awaited<ReturnType<FakeConnector['introspect']>>) {
      super();
    }
    override async introspect() {
      return this.catalog();
    }
  }

  it('empty catalog WITH warnings is surfaced, not treated as an empty database', async () => {
    const conn = new MaskingConnector(() => ({
      ...CATALOG,
      tables: [],
      warnings: ['Could not read tables: permission denied'],
    }));
    const engine = createAskSql({ connectors: [conn], model: model(['x']) });
    await expect(engine.catalog()).rejects.toMatchObject({ code: 'DB_QUERY_ERROR' });
  });

  it('a poisoned empty catalog is never cached - a recovered introspect is seen', async () => {
    let first = true;
    const conn = new MaskingConnector(() => {
      if (first) {
        first = false;
        return { ...CATALOG, tables: [], warnings: ['transient failure'] };
      }
      return CATALOG;
    });
    const engine = createAskSql({ connectors: [conn], model: model(['x']) });
    await expect(engine.catalog()).rejects.toMatchObject({ code: 'DB_QUERY_ERROR' });
    const cat = await engine.catalog();
    expect(cat.tables.length).toBeGreaterThan(0);
  });

  it('a genuinely empty database (no warnings) is fine', async () => {
    const conn = new MaskingConnector(() => ({ ...CATALOG, tables: [], warnings: [] }));
    const engine = createAskSql({ connectors: [conn], model: model(['x']) });
    const cat = await engine.catalog();
    expect(cat.tables).toEqual([]);
  });
});

describe('event stream', () => {
  it('emits stage events through the pipeline', async () => {
    const stages: string[] = [];
    const engine = createAskSql({
      connectors: [new FakeConnector()],
      model: model(['```sql\nSELECT 1\n```']),
      onEvent: (e) => {
        if (e.type === 'stage') stages.push(e.stage);
      },
    });
    await engine.ask('one');
    expect(stages).toContain('catalog');
    expect(stages).toContain('guard');
    expect(stages).toContain('done');
  });
});
