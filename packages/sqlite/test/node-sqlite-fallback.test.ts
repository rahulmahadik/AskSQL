/**
 * The `node:sqlite` fallback, actually exercised. live.test.ts cannot reach it: better-sqlite3 is
 * installed here and always wins the import. This forces that import to fail, as a user without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('better-sqlite3', () => {
  throw new Error("Cannot find module 'better-sqlite3'");
});

const file = join(tmpdir(), `asksql-nodesqlite-${process.pid}.db`);

beforeAll(() => {
  const seed = new DatabaseSync(file);
  seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a')");
  seed.close();
});
afterAll(() => rmSync(file, { force: true }));

describe('with better-sqlite3 unavailable, node:sqlite carries the connector', () => {
  it('really is using node:sqlite, not the native driver', async () => {
    const { SqliteConnector } = await import('../src/index.js');
    const conn = new SqliteConnector({ id: 'n', name: 'N', file });
    await conn.connect();
    try {
      // better-sqlite3 handles expose `.raw`/`.safeIntegers`; DatabaseSync does not. Without this
      // the rest of the file would silently re-test better-sqlite3 all over again.
      const handle = (conn as unknown as { db: object }).db;
      expect(handle).toBeInstanceOf(DatabaseSync);
    } finally {
      await conn.close();
    }
  });

  it('opens a file path, introspects it, and reads rows', async () => {
    const { SqliteConnector } = await import('../src/index.js');
    const conn = new SqliteConnector({ id: 'n2', name: 'N2', file });
    await conn.connect();
    try {
      expect((await conn.introspect()).tables.map((t) => t.name)).toContain('t');
      expect((await conn.execute('SELECT v FROM t')).rows).toEqual([['a']]);
    } finally {
      await conn.close();
    }
  });

  // The reason the fallback needs its own coverage: node:sqlite spells the open flag differently
  // and ignores option keys it does not recognise, so "opened read-only" cannot be taken on trust.
  it('is genuinely read-only, verified by PRAGMA rather than by the open flag', async () => {
    const { SqliteConnector } = await import('../src/index.js');
    const conn = new SqliteConnector({ id: 'n3', name: 'N3', file });
    await conn.connect();
    try {
      const handle = (conn as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
      expect(handle.prepare('PRAGMA query_only').all()).toEqual([{ query_only: 1 }]);
      await expect(conn.execute("INSERT INTO t VALUES (2, 'b')")).rejects.toThrow();
      expect((await conn.execute('SELECT count(*) FROM t')).rows.flat().map(String)).toEqual(['1']);
    } finally {
      await conn.close();
    }
  });

  it('reports a missing file as a configuration problem, not a missing driver', async () => {
    const { SqliteConnector } = await import('../src/index.js');
    const conn = new SqliteConnector({ id: 'n4', name: 'N4', file: join(tmpdir(), 'asksql-does-not-exist.db') });
    await expect(conn.connect()).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});
