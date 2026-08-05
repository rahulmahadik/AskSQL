/**
 * Regression: a timeout or abort in the browser connector must cancel the WASM query. Without
 * the interrupt the worker keeps running and the tab's single shared connection is wedged, with
 * no recovery short of a reload. duckdb-wasm is mocked; only the cancellation wiring is under test.
 */

import { describe, expect, it, vi } from 'vitest';
import { DuckDbWasmConnector } from '../src/browser.js';

const h = vi.hoisted(() => ({ cancels: 0 }));

vi.mock('@duckdb/duckdb-wasm', () => {
  const conn = {
    query: async () => ({ schema: { fields: [] }, toArray: () => [], numRows: 0 }),
    // A query that never yields a batch, so only cancellation ends it.
    send: async () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
    cancelSent: async () => {
      h.cancels++;
      return true;
    },
    close: async () => {},
  };
  return {
    getJsDelivrBundles: () => ({ mvp: { mainModule: 'm', mainWorker: 'w' } }),
    selectBundle: async (b: Record<string, unknown>) => b['mvp'],
    ConsoleLogger: class {},
    AsyncDuckDB: class {
      async instantiate() {}
      async open() {}
      async connect() {
        return conn;
      }
      async registerFileText() {}
      async terminate() {}
    },
    DuckDBDataProtocol: { BROWSER_FILEREADER: 1 },
  };
});

// The connector constructs a Worker from the bundle URL.
vi.stubGlobal(
  'Worker',
  class {
    terminate() {}
  },
);

async function connected(): Promise<DuckDbWasmConnector> {
  const c = new DuckDbWasmConnector({ id: 'w', name: 'w' });
  await c.connect();
  return c;
}

describe('duckdb-wasm query cancellation', () => {
  it('cancels the pending query when the deadline passes', async () => {
    h.cancels = 0;
    const c = await connected();
    await expect(c.execute('SELECT 1', { timeoutMs: 10 })).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    expect(h.cancels).toBe(1);
  });

  it('cancels the pending query on abort', async () => {
    h.cancels = 0;
    const c = await connected();
    const ctl = new AbortController();
    const p = c.execute('SELECT 1', { signal: ctl.signal, timeoutMs: 5000 });
    await new Promise((r) => setImmediate(r));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(h.cancels).toBe(1);
  });
});
