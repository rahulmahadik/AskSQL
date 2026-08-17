/**
 * Room defaults to WAL, so an Android database is three files. An `adb pull app.db` takes only the
 * first, and SQLite then reports no tables at all - an empty database with nothing to say why. The
 * sidecar's size is read BEFORE opening, because SQLite creates an empty -wal itself on open.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteConnector } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A WAL database whose rows are still in the -wal, as a running app leaves it. */
function walDatabase(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asksql-wal-'));
  dirs.push(dir);
  const file = join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA wal_autocheckpoint=0');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO users VALUES (1,'Ada'),(2,'Grace')");
  // Copy the main file while the -wal still holds the rows, then close.
  const pulledDir = mkdtempSync(join(tmpdir(), 'asksql-pull-'));
  dirs.push(pulledDir);
  const pulled = join(pulledDir, 'app.db');
  copyFileSync(file, pulled);
  db.close();
  return { dir, file: pulled };
}

describe('a WAL database copied without its sidecars', () => {
  it('says the -wal is missing instead of reporting an empty database', async () => {
    const { file } = walDatabase();
    // Guard the fixture: if the copy already had the rows, the test would prove nothing.
    expect(statSync(file).size).toBeGreaterThan(0);
    const c = new SqliteConnector({ id: 's', name: 's', file });
    await c.connect();
    const catalog = await c.introspect();
    expect(catalog.tables).toHaveLength(0);
    expect(catalog.warnings.join(' ')).toMatch(/-wal/);
    await c.close();
  });

  it('says nothing when the sidecars are present and the rows are readable', async () => {
    const { dir } = walDatabase();
    const c = new SqliteConnector({ id: 's', name: 's', file: join(dir, 'app.db') });
    await c.connect();
    const catalog = await c.introspect();
    expect(catalog.tables.map((t) => t.name)).toContain('users');
    expect(catalog.warnings.filter((w) => w.includes('-wal'))).toEqual([]);
    const rows = await c.execute('SELECT id, name FROM users ORDER BY id', { maxRows: 10 });
    expect(rows.rowCount).toBe(2);
    await c.close();
  });

  it('says nothing about a database that uses a rollback journal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asksql-journal-'));
    dirs.push(dir);
    const file = join(dir, 'plain.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE t (a INTEGER)');
    db.close();
    const c = new SqliteConnector({ id: 's', name: 's', file });
    await c.connect();
    const catalog = await c.introspect();
    expect(catalog.warnings.filter((w) => w.includes('-wal'))).toEqual([]);
    await c.close();
  });
});
