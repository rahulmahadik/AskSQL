/**
 * A query that timed out or was cancelled may still be running on its connection. Rolling back on
 * that connection can block for as long as the statement does, and returning it to the pool hands
 * the next caller a connection mid-statement. Neither is allowed to happen. mysql2 is mocked.
 */

import { describe, expect, it, vi } from 'vitest';
import { MysqlConnector } from '../src/index.js';

const h = vi.hoisted(() => ({
  statements: [] as string[],
  released: 0,
  destroyed: 0,
  /** Resolves only when the test lets it, standing in for a statement still running server-side. */
  hangRollback: false,
  hangQuery: false,
}));

vi.mock('mysql2/promise', () => ({
  createPool: () => ({
    getConnection: async () => ({
      query: async (arg: string | { sql: string }) => {
        const sql = typeof arg === 'string' ? arg : arg.sql;
        h.statements.push(sql);
        if (/CONNECTION_ID/.test(sql)) return [[{ id: 7 }], []];
        if (/^ROLLBACK/i.test(sql) && h.hangRollback) await new Promise(() => {});
        if (/SLEEP/i.test(sql)) {
          if (h.hangQuery) await new Promise((r) => setTimeout(r, 5_000));
          throw new Error('mock: statement killed');
        }
        return [[], []];
      },
      release: () => {
        h.released++;
      },
      destroy: () => {
        h.destroyed++;
      },
    }),
    query: async () => [[], []],
    end: async () => {},
  }),
}));

function connector() {
  return new MysqlConnector({ id: 'm', name: 'm', host: 'db.example', database: 'app' });
}

describe('a connection that may still be running is not reused', () => {
  it('does not roll back on a timed-out connection, and drops it', async () => {
    h.statements = [];
    h.released = 0;
    h.destroyed = 0;
    h.hangRollback = true; // a rollback here would never return
    h.hangQuery = true;

    const c = connector();
    await c.connect();
    await expect(c.execute('SELECT SLEEP(30)', { timeoutMs: 30 })).rejects.toThrow();
    h.hangQuery = false;
    await c.close();

    expect(h.statements.some((s) => /^ROLLBACK/i.test(s))).toBe(false);
    expect(h.destroyed).toBeGreaterThan(0);
  });

  it('still rolls back and returns the connection after an ordinary error', async () => {
    h.statements = [];
    h.released = 0;
    h.destroyed = 0;
    h.hangRollback = false;

    const c = connector();
    await c.connect();
    await expect(c.execute('SELECT SLEEP(1)')).rejects.toThrow();
    await c.close();

    expect(h.statements.some((s) => /^ROLLBACK/i.test(s))).toBe(true);
    expect(h.released).toBeGreaterThan(0);
    expect(h.destroyed).toBe(0);
  });
});
