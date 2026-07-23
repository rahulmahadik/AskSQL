/**
 * Connector error paths that need no engine: the missing-driver message and
 * the not-connected guard. The driver import is mocked to fail, so this file
 * must not share a module graph with the engine-backed tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { DuckDbConnector } from '../src/index.js';

vi.mock('@duckdb/node-api', () => {
  throw new Error("Cannot find module '@duckdb/node-api'");
});

describe('driver not installed', () => {
  it('maps the failed import to CONFIG_ERROR with an install hint', async () => {
    const c = new DuckDbConnector({ id: 'd', name: 'd' });
    await expect(c.connect()).rejects.toMatchObject({
      name: 'AskSqlError',
      code: 'CONFIG_ERROR',
      userMessage: 'The DuckDB engine is not installed. Run: npm install @duckdb/node-api',
    });
  });
});

describe('not connected', () => {
  it('rejects execute() with DB_UNREACHABLE before touching the driver', async () => {
    const c = new DuckDbConnector({ id: 'd', name: 'd' });
    await expect(c.execute('SELECT 1')).rejects.toMatchObject({ code: 'DB_UNREACHABLE' });
  });
});
