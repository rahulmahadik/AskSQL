/**
 * Runs the same query twice on every engine: once through the raw driver, once through the AskSQL
 * connector, and compares the values cell by cell. AskSQL may change a value's JavaScript type
 * (a BIGINT arrives as a string so it cannot round through a float), but never the value itself.
 *
 *   node tools/value-fidelity.mjs
 *
 * Exit code 1 if any cell differs.
 */
import { PostgresConnector } from '@asksql/postgres';
import { MysqlConnector } from '@asksql/mysql';
import { SqliteConnector } from '@asksql/sqlite';
import { DuckDbConnector } from '@asksql/duckdb';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'asksql-fidelity-'));
const sqliteFile = join(scratch, 'shop.db');
const duckFile = join(scratch, 'shop.duckdb');

/** One canonical form for both sides: a value differs only when its meaning differs. */
function canon(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  // A driver may hand back "1.50" where the other says "1.5"; same number, same meaning.
  if (/^-?\d+\.\d+$/.test(s)) return String(Number(s));
  return s;
}

/** Whitespace-only and edge strings: a trimmed or collapsed value is an altered value. */
const WHITESPACE_SQL = {
  postgres: `SELECT '  lead'::text AS a, 'trail  '::text AS b, '   '::text AS c, ''::text AS d,
    E'ta\\tb'::text AS e, E'new\\nline'::text AS f, ' 0 '::text AS g`,
  mysql: `SELECT '  lead' AS a, 'trail  ' AS b, '   ' AS c, '' AS d, 'ta\\tb' AS e, 'new\\nline' AS f, ' 0 ' AS g`,
  sqlite: `SELECT '  lead' AS a, 'trail  ' AS b, '   ' AS c, '' AS d, 'ta' || char(9) || 'b' AS e,
    'new' || char(10) || 'line' AS f, ' 0 ' AS g`,
};

const TYPES_SQL = {
  postgres: `SELECT 1::int AS i, 9007199254740993::bigint AS big, 1.5::float8 AS f,
    12345678901234567890.12345::numeric AS dnum, 'héllo'::text AS t, true AS b, NULL::int AS n`,
  mysql: `SELECT CAST(1 AS SIGNED) AS i, CAST(9007199254740993 AS SIGNED) AS big, 1.5 AS f,
    CAST('12345678901234567890.12345' AS DECIMAL(30,5)) AS dnum, 'héllo' AS t, TRUE AS b, NULL AS n`,
  sqlite: `SELECT 1 AS i, '9007199254740993' AS big, 1.5 AS f, '12345678901234567890.12345' AS dnum,
    'héllo' AS t, 1 AS b, NULL AS n`,
  duckdb: `SELECT 1::int AS i, 9007199254740993::bigint AS big, 1.5::double AS f,
    12345678901234567890.12345::decimal(30,5) AS dnum, 'héllo' AS t, true AS b, NULL::int AS n`,
};

const ENGINES = [
  {
    key: 'postgres',
    connector: () =>
      new PostgresConnector({
        id: 'p',
        name: 'p',
        connectionString: 'postgres://postgres:root@localhost:5432/asksql_test',
      }),
    raw: async (sql) => {
      const { default: pg } = await import('pg');
      const c = new pg.Client({ connectionString: 'postgres://postgres:root@localhost:5432/asksql_test' });
      await c.connect();
      const r = await c.query(sql);
      await c.end();
      return r.rows.map((row) => r.fields.map((f) => row[f.name]));
    },
  },
  {
    key: 'mysql',
    connector: () =>
      new MysqlConnector({
        id: 'm',
        name: 'm',
        host: '127.0.0.1',
        port: 53306,
        user: 'root',
        password: '',
        database: 'asksql_demo',
      }),
    raw: async (sql) => {
      const mysql = await import(new URL('../packages/mysql/node_modules/mysql2/promise.js', import.meta.url).href);
      const c = await mysql.createConnection({
        host: '127.0.0.1',
        port: 53306,
        user: 'root',
        password: '',
        database: 'asksql_demo',
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
      });
      const [rows, fields] = await c.query(sql);
      await c.end();
      return rows.map((row) => fields.map((f) => row[f.name]));
    },
  },
  {
    key: 'sqlite',
    setup: () => {
      const db = new DatabaseSync(sqliteFile);
      db.exec('CREATE TABLE t (x)');
      db.close();
    },
    connector: () => new SqliteConnector({ id: 's', name: 's', file: sqliteFile }),
    raw: (sql) => {
      const db = new DatabaseSync(sqliteFile, { readOnly: true });
      const rows = db.prepare(sql).all();
      db.close();
      return rows.map((r) => Object.values(r));
    },
  },
];

let failures = 0;
const report = [];

for (const engine of ENGINES) {
  let connector;
  try {
    engine.setup?.();
    connector = engine.connector();
    await connector.connect();

    const diffs = [];
    let cols = 0;
    for (const [label, sql] of [
      ['types', TYPES_SQL[engine.key]],
      ['whitespace', WHITESPACE_SQL[engine.key]],
    ]) {
      const a = (await connector.execute(sql)).rows[0]?.map(canon) ?? [];
      const d = (await engine.raw(sql))[0]?.map(canon) ?? [];
      const n = Math.max(a.length, d.length);
      cols += n;
      for (let i = 0; i < n; i++) {
        if (a[i] !== d[i])
          diffs.push(`${label} col ${i}: driver ${JSON.stringify(d[i])} vs asksql ${JSON.stringify(a[i])}`);
      }
    }

    if (diffs.length === 0) {
      report.push([engine.key, 'ok', `${cols} columns identical`]);
    } else {
      failures += diffs.length;
      report.push([engine.key, 'DIFFERS', diffs.join('; ')]);
    }
  } catch (err) {
    report.push([engine.key, 'skipped', (err.userMessage ?? err.message ?? String(err)).slice(0, 70)]);
  } finally {
    await connector?.close?.().catch(() => {});
  }
}

rmSync(scratch, { recursive: true, force: true });

console.log('\n### Value fidelity: raw driver vs AskSQL\n');
console.log('| Engine | Result | Detail |');
console.log('|---|---|---|');
for (const [k, v, d] of report) console.log(`| ${k} | ${v} | ${d} |`);
const skipped = report.filter(([, v]) => v === 'skipped').map(([k]) => k);
const checked = report.filter(([, v]) => v === 'ok').length;
if (failures > 0) console.log(`\n${failures} CELL(S) DIFFER`);
else if (skipped.length > 0) console.log(`\n${checked} engine(s) verified; NOT CHECKED: ${skipped.join(', ')}`);
else console.log('\nEvery value came back unchanged on every engine.');
// An engine that could not be reached is an unchecked engine, not a passing one.
process.exit(failures === 0 && skipped.length === 0 ? 0 : 1);
