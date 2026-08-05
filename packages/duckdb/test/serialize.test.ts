/**
 * Regression: the Node connector holds ONE DuckDB connection, and interrupt() aborts whatever
 * that connection is running - not just the query that asked. A second query must therefore wait
 * its turn rather than sit in withQueryTimeout with a live abort listener. The driver is mocked so
 * the interleaving is deterministic.
 */

import { describe, expect, it, vi } from 'vitest';
import { DuckDbConnector } from '../src/index.js';

const h = vi.hoisted(() => ({
  prepared: [] as string[],
  interrupts: 0,
  /** Resolves the reader for the first prepared statement. */
  release: undefined as undefined | (() => void),
}));

const reader = {
  getRowObjects: () => [],
  getRows: () => [],
  columnNames: () => ['a'],
  columnTypes: () => [{ toString: () => 'INTEGER' }],
};

vi.mock('@duckdb/node-api', () => ({
  DuckDBInstance: {
    create: async () => ({
      connect: async () => ({
        run: async () => undefined,
        runAndReadUntil: async () => reader,
        prepare: async (sql: string) => {
          h.prepared.push(sql);
          return {
            runAndReadUntil: async () => {
              if (h.prepared.length === 1) await new Promise<void>((r) => (h.release = r));
              return reader;
            },
          };
        },
        interrupt: () => {
          h.interrupts++;
        },
        disconnectSync: () => {},
        closeSync: () => {},
      }),
      closeSync: () => {},
    }),
  },
}));

describe('execute() is serialized per connector', () => {
  it('a queued query neither starts nor interrupts while another is running', async () => {
    const c = new DuckDbConnector({ id: 'd', name: 'd' });
    await c.connect();

    const first = c.execute('SELECT 1');
    const ctl = new AbortController();
    const second = c.execute('SELECT 2', { signal: ctl.signal });
    await new Promise((r) => setImmediate(r));

    // The second statement has not been compiled: it is waiting, holding no connection.
    expect(h.prepared).toEqual(['SELECT 1']);

    // Aborting it must not reach interrupt(), which would kill the running first query.
    ctl.abort();
    await new Promise((r) => setImmediate(r));
    expect(h.interrupts).toBe(0);

    h.release!();
    await expect(first).resolves.toMatchObject({ rowCount: 0 });
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(h.prepared).toEqual(['SELECT 1']);
    await c.close();
  });
});
