/**
 * Regression: the per-query deadline must not outlive the query. `SET SESSION
 * MAX_EXECUTION_TIME` is not transactional and release() does not reset session state, so the
 * next caller of that pooled connection - typically introspect(), which has no deadline of its
 * own - inherited the cap and died with ER_QUERY_TIMEOUT. mysql2 is mocked.
 */

import { describe, expect, it, vi } from 'vitest';
import { MysqlConnector } from '../src/index.js';

const h = vi.hoisted(() => ({ statements: [] as string[] }));

vi.mock('mysql2/promise', () => ({
  createPool: () => ({
    getConnection: async () => ({
      query: async (arg: string | { sql: string }) => {
        const sql = typeof arg === 'string' ? arg : arg.sql;
        h.statements.push(sql);
        if (/CONNECTION_ID/.test(sql)) return [[{ id: 7 }], []];
        return [[], []];
      },
      release: () => {},
    }),
    query: async () => [[], []],
    end: async () => {},
  }),
}));

async function run(sql: string, timeoutMs = 1234): Promise<string[]> {
  h.statements = [];
  const c = new MysqlConnector({ id: 'm', name: 'm', host: 'db.example', database: 'app' });
  await c.connect();
  await c.execute(sql, { timeoutMs });
  await c.close();
  return h.statements;
}

describe('query deadline is statement-scoped', () => {
  it('sets no session variable and hints the statement instead', async () => {
    const seen = await run('SELECT id FROM orders LIMIT 10');
    expect(seen.some((s) => /SET SESSION/i.test(s))).toBe(false);
    expect(seen).toContain('SELECT /*+ MAX_EXECUTION_TIME(1234) */ id FROM orders LIMIT 10');
  });

  it('hints past a leading comment', async () => {
    const seen = await run('-- top orders\nSELECT 1');
    expect(seen).toContain('-- top orders\nSELECT /*+ MAX_EXECUTION_TIME(1234) */ 1');
  });

  it('leaves a statement the hint cannot reach untouched', async () => {
    const seen = await run('SHOW TABLES');
    expect(seen).toContain('SHOW TABLES');
    expect(seen.some((s) => /MAX_EXECUTION_TIME/i.test(s))).toBe(false);
  });
});
