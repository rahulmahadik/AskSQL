/**
 * Loads the Chinook sample database into all six local engines so tools/real-db-e2e.mjs can ask
 * every engine the same questions about the same real data.
 *
 *   node tools/real-db-load.mjs
 *
 * Everything lands in a database named asksql_e2e, never in asksql_test, which other tests read.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DATA_DIR = join(tmpdir(), 'asksql-real-db');
export const SQLITE_FILE = join(DATA_DIR, 'chinook.db');
export const DUCK_FILE = join(DATA_DIR, 'chinook.duckdb');
export const PG_URL = 'postgres://postgres:root@localhost:5432/asksql_e2e';
export const MY = { host: '127.0.0.1', port: 53306, user: 'root', password: '', database: 'asksql_e2e' };
export const ORA = { user: 'chinook', password: 'chinook', connectString: 'localhost:1521/FREEPDB1' };
export const MONGO_URL = 'mongodb://localhost:27017';

const BASE = 'https://raw.githubusercontent.com/lerocha/chinook-database/master/ChinookDatabase/DataSources';
const DUMPS = ['Chinook_PostgreSql.sql', 'Chinook_MySql.sql', 'Chinook_Sqlite.sql', 'Chinook_Oracle.sql'];
const MYSQL_BIN = '/opt/homebrew/opt/mysql-client/bin/mysql';

/** Statements terminated by a semicolon at end of line, with comments removed first. */
export function splitStatements(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s && !/^(commit|exit)$/i.test(s));
}

function download() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const name of DUMPS) {
    const path = join(DATA_DIR, name);
    if (existsSync(path) && statSync(path).size > 100_000) continue;
    execFileSync('curl', ['-sfL', `${BASE}/${name}`, '-o', path]);
  }
}

function loadSqlite() {
  rmSync(SQLITE_FILE, { force: true });
  execFileSync('sqlite3', [SQLITE_FILE], { input: readFileSync(join(DATA_DIR, 'Chinook_Sqlite.sql')) });
  const db = new DatabaseSync(SQLITE_FILE, { readOnly: true });
  const n = db.prepare('SELECT count(*) AS n FROM Track').get().n;
  db.close();
  return `Track ${n}`;
}

function loadPostgres() {
  // The dump creates and connects to its own database; we route it into asksql_e2e instead.
  const clean = join(DATA_DIR, 'pg_clean.sql');
  writeFileSync(
    clean,
    readFileSync(join(DATA_DIR, 'Chinook_PostgreSql.sql'), 'utf8').replace(
      /^\s*(DROP DATABASE|CREATE DATABASE|\\c ).*$/gm,
      '',
    ),
  );
  const env = { ...process.env, PGPASSWORD: 'root' };
  const psql = (args) =>
    execFileSync('psql', ['-h', 'localhost', '-p', '5432', '-U', 'postgres', ...args], { env, stdio: 'pipe' });
  psql(['-d', 'postgres', '-q', '-c', 'DROP DATABASE IF EXISTS asksql_e2e']);
  psql(['-d', 'postgres', '-q', '-c', 'CREATE DATABASE asksql_e2e']);
  psql(['-d', 'asksql_e2e', '-q', '-v', 'ON_ERROR_STOP=1', '-f', clean]);
  return `Track ${String(psql(['-d', 'asksql_e2e', '-tAc', 'SELECT count(*) FROM track'])).trim()}`;
}

function loadMysql() {
  const clean = join(DATA_DIR, 'my_clean.sql');
  writeFileSync(
    clean,
    readFileSync(join(DATA_DIR, 'Chinook_MySql.sql'), 'utf8').replace(
      /^\s*(DROP DATABASE|CREATE DATABASE|USE )\s*`?\w+`?.*$/gm,
      '',
    ),
  );
  const bin = existsSync(MYSQL_BIN) ? MYSQL_BIN : 'mysql';
  const my = (args, opts) =>
    execFileSync(bin, ['-h', MY.host, '-P', String(MY.port), '-u', MY.user, ...args], { stdio: 'pipe', ...opts });
  my(['-e', 'DROP DATABASE IF EXISTS asksql_e2e; CREATE DATABASE asksql_e2e']);
  my([MY.database], { input: readFileSync(clean) });
  return `Track ${String(my(['-N', '-B', MY.database, '-e', 'SELECT count(*) FROM Track'])).trim()}`;
}

async function loadOracle() {
  const oracledb = (await import(new URL('../packages/oracle/node_modules/oracledb/index.js', import.meta.url).href))
    .default;
  const text = readFileSync(join(DATA_DIR, 'Chinook_Oracle.sql'), 'utf8');
  const marker = 'CONNECT chinook/chinook@FREEPDB1;';
  const body = text.slice(text.indexOf(marker) + marker.length);

  const admin = await oracledb.getConnection({ user: 'system', password: 'root', connectString: ORA.connectString });
  for (const stmt of [
    `BEGIN EXECUTE IMMEDIATE 'DROP USER chinook CASCADE'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    `CREATE USER chinook IDENTIFIED BY chinook`,
    `GRANT CONNECT, RESOURCE, UNLIMITED TABLESPACE, CREATE TABLE, CREATE VIEW TO chinook`,
  ]) {
    await admin.execute(stmt);
  }
  await admin.close();

  const conn = await oracledb.getConnection(ORA);
  const failed = [];
  for (const stmt of splitStatements(body)) {
    try {
      await conn.execute(stmt);
    } catch (err) {
      failed.push(`${stmt.slice(0, 60).replace(/\s+/g, ' ')} => ${err.message.split('\n')[0]}`);
    }
  }
  await conn.commit();
  const n = (await conn.execute('SELECT count(*) FROM Track')).rows[0][0];
  await conn.close();
  if (failed.length) throw new Error(`${failed.length} Oracle statements failed: ${failed[0]}`);
  return `Track ${n}`;
}

/** SQLite declared types map onto DuckDB closely enough for a faithful copy. */
function duckType(decl) {
  const t = String(decl || '').toUpperCase();
  if (/INT/.test(t)) return 'BIGINT';
  if (/NUMERIC|DECIMAL/.test(t)) return 'DECIMAL(18,4)';
  if (/REAL|FLOA|DOUB/.test(t)) return 'DOUBLE';
  if (/DATETIME|TIMESTAMP/.test(t)) return 'TIMESTAMP';
  return 'VARCHAR';
}

const literal = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

/** DuckDB and MongoDB are filled from the loaded SQLite copy, so all six hold identical rows. */
async function loadDuckAndMongo() {
  const { DuckDBInstance } = await import(
    new URL('../packages/duckdb/node_modules/@duckdb/node-api/lib/index.js', import.meta.url).href
  );
  const { MongoClient } = await import(
    new URL('../packages/mongodb/node_modules/mongodb/lib/index.js', import.meta.url).href
  );

  const src = new DatabaseSync(SQLITE_FILE, { readOnly: true });
  const tables = src
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);

  rmSync(DUCK_FILE, { force: true });
  const duck = await (await DuckDBInstance.create(DUCK_FILE)).connect();
  const mongo = new MongoClient(MONGO_URL);
  await mongo.connect();
  const mdb = mongo.db('asksql_e2e');
  await mdb.dropDatabase();

  for (const table of tables) {
    const cols = src.prepare(`PRAGMA table_info("${table}")`).all();
    const rows = src.prepare(`SELECT * FROM "${table}"`).all();
    await duck.run(`CREATE TABLE "${table}" (${cols.map((c) => `"${c.name}" ${duckType(c.type)}`).join(', ')})`);
    if (!rows.length) continue;

    const names = cols.map((c) => `"${c.name}"`).join(', ');
    // One multi-row INSERT per chunk: a statement per row turns this into minutes.
    for (let i = 0; i < rows.length; i += 500) {
      const values = rows
        .slice(i, i + 500)
        .map((r) => `(${cols.map((c) => literal(r[c.name])).join(', ')})`)
        .join(', ');
      await duck.run(`INSERT INTO "${table}" (${names}) VALUES ${values}`);
    }
    await mdb.collection(table).insertMany(
      rows.map((r) =>
        Object.fromEntries(cols.map((c) => [c.name, typeof r[c.name] === 'bigint' ? Number(r[c.name]) : r[c.name]])),
      ),
      { ordered: false },
    );
  }

  const duckTracks = (await duck.runAndReadAll('SELECT count(*) FROM "Track"')).getRows()[0][0];
  const mongoTracks = await mdb.collection('Track').countDocuments();
  src.close();
  await mongo.close();
  return { duckdb: `Track ${duckTracks}`, mongodb: `Track ${mongoTracks}` };
}

async function main() {
  download();
  const report = [];
  const step = async (name, fn) => {
    try {
      report.push([name, 'loaded', await fn()]);
    } catch (err) {
      report.push([name, 'FAILED', (err.message ?? String(err)).split('\n')[0].slice(0, 90)]);
    }
  };

  await step('sqlite', loadSqlite);
  await step('postgres', loadPostgres);
  await step('mysql', loadMysql);
  await step('oracle', loadOracle);
  try {
    const both = await loadDuckAndMongo();
    report.push(['duckdb', 'loaded', both.duckdb], ['mongodb', 'loaded', both.mongodb]);
  } catch (err) {
    report.push(['duckdb/mongodb', 'FAILED', (err.message ?? String(err)).split('\n')[0].slice(0, 90)]);
  }

  console.log('\n| Engine | Result | Rows |');
  console.log('|---|---|---|');
  for (const [a, b, c] of report) console.log(`| ${a} | ${b} | ${c} |`);
  const bad = report.filter(([, r]) => r !== 'loaded').length;
  console.log(bad ? `\n${bad} ENGINE(S) NOT LOADED` : '\nAll six engines hold the same Chinook data.');
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
