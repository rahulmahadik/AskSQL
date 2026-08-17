/**
 * Nothing in a SQLite schema says whether an integer timestamp counts seconds or milliseconds, and
 * guessing seconds against milliseconds matches every row. Measured on the Room fixture: 30B answered
 * 5 of 5 users, 7B answered 0. The unit comes from an aggregate, so no value reaches the model.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteConnector } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A table with one integer column holding `value`, introspected. */
async function commentFor(
  columnName: string,
  dbType: string,
  value: number | bigint,
): Promise<string | null | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'asksql-epoch-'));
  dirs.push(dir);
  const file = join(dir, 'app.db');
  const db = new DatabaseSync(file);
  // No second column when the column under test is itself named id.
  const extra = columnName === 'id' ? '' : 'id INTEGER PRIMARY KEY, ';
  db.exec(`CREATE TABLE t (${extra}"${columnName}" ${dbType})`);
  const stmt = db.prepare(`INSERT INTO t ("${columnName}") VALUES (?)`);
  stmt.run(typeof value === 'bigint' ? value : Math.trunc(value));
  db.close();
  const c = new SqliteConnector({ id: 's', name: 's', file });
  await c.connect();
  const catalog = await c.introspect();
  await c.close();
  return catalog.tables.find((t) => t.name === 't')?.columns.find((col) => col.name === columnName)?.comment;
}

describe('the unit of an integer timestamp is stated', () => {
  it('calls a milliseconds column milliseconds', async () => {
    expect(await commentFor('created_at', 'INTEGER', 1_755_300_000_000)).toBe('epoch milliseconds');
  });

  it('calls a seconds column seconds', async () => {
    expect(await commentFor('created_at', 'INTEGER', 1_755_300_000)).toBe('epoch seconds');
  });

  it('recognises microseconds and nanoseconds', async () => {
    expect(await commentFor('sent_at', 'INTEGER', 1_755_300_000_000_000)).toBe('epoch microseconds');
    expect(await commentFor('sent_at', 'BIGINT', 1_755_300_000_000_000_000n)).toBe('epoch nanoseconds');
  });

  it('reads the name in the shapes Room and hand-written schemas use', async () => {
    for (const name of ['created_at', 'updated_at', 'sent_at', 'timestamp', 'start_time', 'expires', 'due_date']) {
      expect(await commentFor(name, 'INTEGER', 1_755_300_000_000), name).toBe('epoch milliseconds');
    }
  });
});

describe('what it must not annotate', () => {
  it('says nothing about a column that is not a timestamp by name', async () => {
    // A large integer that is an id, a byte count or a price is not a moment.
    expect(await commentFor('size_bytes', 'INTEGER', 1_755_300_000_000)).toBeFalsy();
    expect(await commentFor('id', 'INTEGER', 1_755_300_000_000)).toBeFalsy();
  });

  it('says nothing about a text or real column', async () => {
    expect(await commentFor('created_at', 'TEXT', 1_755_300_000_000)).toBeFalsy();
    expect(await commentFor('created_at', 'REAL', 1_755_300_000_000)).toBeFalsy();
  });

  it('says nothing when the magnitude is too small to be a modern timestamp', async () => {
    // A duration in seconds, or a year: guessing here would be worse than silence.
    expect(await commentFor('start_time', 'INTEGER', 3_600)).toBeFalsy();
    expect(await commentFor('created_at', 'INTEGER', 2026)).toBeFalsy();
  });

  it('says nothing about an empty table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asksql-epoch-empty-'));
    dirs.push(dir);
    const file = join(dir, 'app.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE t (created_at INTEGER)');
    db.close();
    const c = new SqliteConnector({ id: 's', name: 's', file });
    await c.connect();
    const catalog = await c.introspect();
    await c.close();
    expect(catalog.tables[0]?.columns[0]?.comment).toBeFalsy();
  });
});
