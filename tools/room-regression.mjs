#!/usr/bin/env node
/**
 * The engine against a database shaped the way Room leaves one, which is what an Android Studio user
 * opens. No model: every expectation is a fact about the schema, so this can gate CI.
 *
 * Every fixture the suite owned used real types - Chinook's InvoiceDate is a DATETIME - so nothing
 * exercised epoch-millis dates, Long ids past a double, BLOBs, or Room's bookkeeping and FTS tables.
 * Five defects surfaced the first time such a database was tried.
 *
 * Usage: node tools/room-regression.mjs
 */
import { mkdtempSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const core = await import('../packages/core/dist/index.js');
const semantics = await import('../packages/core/dist/semantics.js');
const engineInternals = await import('../packages/core/dist/engine.js');
const { SqliteConnector } = await import('../packages/sqlite/dist/index.js');

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
};
const asyncCheck = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const DAY = 86_400_000;
const now = Date.now();
const BIG_ID = 9007199254740993n;
const dir = mkdtempSync(join(tmpdir(), 'asksql-room-'));
const file = join(dir, 'app.db');

// ---- the fixture: what Room actually writes ----
{
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      prefs TEXT, avatar BLOB
    );
    CREATE UNIQUE INDEX index_users_email ON users (email);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY NOT NULL, sender_id INTEGER NOT NULL, body TEXT NOT NULL,
      sent_at INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX index_messages_sender_id ON messages (sender_id);
    CREATE VIEW active_users AS SELECT id, name FROM users WHERE is_active = 1;
    CREATE TABLE room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT);
    CREATE TABLE android_metadata (locale TEXT);
    INSERT INTO android_metadata VALUES ('en_US');
    CREATE VIRTUAL TABLE messages_fts USING fts4(body, content=messages);
  `);
  const u = db.prepare('INSERT INTO users (id,name,email,is_active,created_at,prefs,avatar) VALUES (?,?,?,?,?,?,?)');
  u.run(1n, 'Ada', 'ada@example.com', 1, now - 2 * DAY, '{"theme":"dark"}', null);
  u.run(2n, 'Grace', 'grace@example.com', 1, now - 5 * DAY, null, null);
  u.run(3n, 'Alan', 'alan@example.com', 0, now - 90 * DAY, null, null);
  u.run(BIG_ID, 'Margaret', 'margaret@example.com', 1, now - 400 * DAY, null, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const m = db.prepare('INSERT INTO messages (id,sender_id,body,sent_at,is_read) VALUES (?,?,?,?,?)');
  m.run(1n, 1n, 'Rope memory is woven, not written', now - 3 * DAY, 1);
  m.run(2n, BIG_ID, 'The simulator agrees', now - 2 * DAY, 0);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  db.close();
}

const connector = new SqliteConnector({ id: 'room', name: 'Room app', file });
await connector.connect();
const catalog = await connector.introspect();
const dialect = core.SQLITE_DIALECT;
const guard = (sql) => core.guardSql({ sql, dialect });

await asyncCheck('a Long id past a double range survives the driver', async () => {
  const r = await connector.execute("SELECT id FROM users WHERE name = 'Margaret'", { maxRows: 1 });
  const got = String(r.rows[0][0]);
  assert(got === BIG_ID.toString(), `id came back as ${got}`);
  return got;
});

await asyncCheck('a BLOB column does not destroy the result set', async () => {
  const r = await connector.execute('SELECT id, avatar FROM users ORDER BY id', { maxRows: 10 });
  assert(r.rowCount === 4, `expected 4 rows, got ${r.rowCount}`);
  return `${r.rowCount} rows, blob preserved`;
});

check('rowid is not reported as an invented column', () => {
  const found = engineInternals.firstUnknownColumn('SELECT rowid, name FROM users', catalog, dialect.grammar);
  assert(found === null, `flagged ${found?.table}.${found?.column}`);
  return 'rowid accepted';
});

check('a full-text query is allowed', () => {
  const v = guard("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'memory'");
  assert(v.allowed, `refused: ${v.reason}`);
  assert(/\bMATCH\b/.test(v.sql), 'the operator did not survive the guard');
  return 'MATCH accepted and preserved';
});

await asyncCheck('the full-text query returns the matching rows', async () => {
  const v = guard("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'memory'");
  const r = await connector.execute(v.sql, { maxRows: 10 });
  assert(r.rowCount === 1, `expected 1 match, got ${r.rowCount}`);
  return `${r.rowCount} row`;
});

check('an epoch column compared with a text date is caught', () => {
  const bad = "SELECT COUNT(*) FROM users WHERE created_at >= date('now','-7 days')";
  const found = semantics.epochUnitMismatch(bad, dialect.grammar, catalog);
  assert(found !== null, 'the comparison was not flagged');
  return `${found.column} (${found.dbType}) vs ${found.comparedTo}`;
});

check('the same column compared in its own units is left alone', () => {
  const good = "SELECT COUNT(*) FROM users WHERE created_at >= (strftime('%s','now') - 7*86400) * 1000";
  assert(semantics.epochUnitMismatch(good, dialect.grammar, catalog) === null, 'correct SQL was flagged');
  return 'accepted';
});

await asyncCheck('the correct epoch form returns the right count', async () => {
  const r = await connector.execute(
    "SELECT COUNT(*) FROM users WHERE created_at >= (strftime('%s','now') - 7*86400) * 1000",
    { maxRows: 1 },
  );
  const got = Number(r.rows[0][0]);
  assert(got === 2, `expected 2 users in the last week, got ${got}`);
  return `${got} users`;
});

check('an INTEGER boolean is readable as a number, not text', () => {
  const v = guard('SELECT COUNT(*) FROM users WHERE is_active = 1');
  assert(v.allowed, `refused: ${v.reason}`);
  return 'accepted';
});

check("Room's bookkeeping and FTS shadow tables are visible to the catalog", () => {
  const names = catalog.tables.map((t) => t.name);
  for (const expected of ['users', 'messages', 'room_master_table', 'android_metadata']) {
    assert(names.includes(expected), `${expected} missing from the catalog`);
  }
  return `${names.length} objects`;
});

await asyncCheck('a write is still refused against an app database', async () => {
  const attempts = ['DELETE FROM messages', 'UPDATE users SET is_active = 0', 'DROP TABLE users'];
  for (const sql of attempts) {
    const v = guard(sql);
    assert(!v.allowed, `${sql} was allowed`);
  }
  const after = await connector.execute('SELECT COUNT(*) FROM users', { maxRows: 1 });
  assert(Number(after.rows[0][0]) === 4, 'the table changed');
  return `${attempts.length} writes refused, 4 users intact`;
});

await connector.close();

// ---- a WAL database copied without its sidecars ----
await asyncCheck('a WAL database missing its -wal says so', async () => {
  const walDir = mkdtempSync(join(tmpdir(), 'asksql-room-wal-'));
  const walFile = join(walDir, 'app.db');
  const db = new DatabaseSync(walFile);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA wal_autocheckpoint=0');
  db.exec('CREATE TABLE t (a INTEGER)');
  db.exec('INSERT INTO t VALUES (1)');
  const pulledDir = mkdtempSync(join(tmpdir(), 'asksql-room-pull-'));
  const pulled = join(pulledDir, 'app.db');
  copyFileSync(walFile, pulled);
  db.close();
  assert(statSync(pulled).size > 0, 'the copy is empty');

  const c = new SqliteConnector({ id: 'w', name: 'w', file: pulled });
  await c.connect();
  const cat = await c.introspect();
  await c.close();
  rmSync(walDir, { recursive: true, force: true });
  rmSync(pulledDir, { recursive: true, force: true });
  assert(cat.tables.length === 0, 'the copy unexpectedly had tables');
  assert(
    cat.warnings.some((w) => w.includes('-wal')),
    `no sidecar warning: ${JSON.stringify(cat.warnings)}`,
  );
  return 'warned instead of reporting an empty database';
});

rmSync(dir, { recursive: true, force: true });

console.log('\n### A Room-shaped SQLite database\n');
console.log('| Check | Result | Detail |');
console.log('|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.ok ? 'ok' : 'FAIL'} | ${r.detail} |`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `All ${results.length} checks passed.` : `${failed.length} CHECK(S) FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
