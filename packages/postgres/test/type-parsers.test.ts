/**
 * Regression: date/time parsers are scoped to this connector's pool. Writing them into pg's
 * process-global `types` registry applies retroactively to the host application's own already-open
 * pools, so `row.created_at.getTime()` starts throwing with no AskSQL frame in the stack.
 */

import { describe, expect, it, vi } from 'vitest';
import { PostgresConnector } from '../src/index.js';

const h = vi.hoisted(() => ({
  poolOptions: undefined as Record<string, unknown> | undefined,
  globalSetCalls: 0,
}));

vi.mock('pg', () => {
  class Pool {
    constructor(options: Record<string, unknown>) {
      h.poolOptions = options;
    }
    async connect() {
      return { processID: 1, query: async () => ({ rows: [], fields: [], rowCount: 0 }), release: () => {} };
    }
    async end() {}
    async query() {
      return { rows: [] };
    }
  }
  return {
    Pool,
    types: {
      setTypeParser: () => {
        h.globalSetCalls++;
      },
      getTypeParser: () => (v: string) => `global:${v}`,
    },
  };
});

describe('pg type parsers are per-pool', () => {
  it('passes them as a pool option and never touches the global registry', async () => {
    const c = new PostgresConnector({ id: 'p', name: 'p', host: 'db.example', database: 'app' });
    await c.connect();

    expect(h.globalSetCalls).toBe(0);
    const types = h.poolOptions?.['types'] as { getTypeParser(oid: number, format?: string): (v: string) => unknown };
    expect(types).toBeDefined();
    // date / timestamp / time / timetz stay raw strings...
    for (const oid of [1082, 1114, 1083, 1266]) expect(types.getTypeParser(oid)('2024-01-15')).toBe('2024-01-15');
    // ...everything else keeps the driver's own parser.
    expect(types.getTypeParser(1184)('x')).toBe('global:x');
    expect(types.getTypeParser(1082, 'binary')('x')).toBe('global:x');
    await c.close();
  });
});
