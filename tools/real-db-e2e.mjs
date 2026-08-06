/**
 * End-to-end check against live databases holding a real open-source schema (Chinook), one per
 * engine. Every engine is asked the same business questions three ways:
 *
 *   1. introspect - the connector must find the real tables and columns
 *   2. fidelity   - the same query through the raw driver and through AskSQL, compared cell by cell
 *   3. read-only  - writes are refused, and the row counts are the same afterwards as before
 *
 *   node tools/real-db-e2e.mjs
 *
 * Needs the six local engines loaded by tools/real-db-load.mjs. Exit code 1 on any difference,
 * any accepted write, or any engine that could not be reached: an unchecked engine is not a pass.
 */
import { PostgresConnector } from '@asksql/postgres';
import { MysqlConnector } from '@asksql/mysql';
import { SqliteConnector } from '@asksql/sqlite';
import { DuckDbConnector } from '@asksql/duckdb';
import { guardSql } from '@asksql/core';
import { guardPipeline } from '@asksql/core/mongo';
// Oracle and MongoDB are not linked into the root workspace, so they are reached by build output.
const { OracleConnector } = await import(new URL('../packages/oracle/dist/index.js', import.meta.url).href);
const { MongodbConnector } = await import(new URL('../packages/mongodb/dist/index.js', import.meta.url).href);
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR, PG_URL, MY, ORA, MONGO_URL, SQLITE_FILE, DUCK_FILE } from './real-db-load.mjs';

/** One canonical form for both sides: a value differs only when its meaning differs. */
function canon(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
  if (typeof v === 'object') {
    // Driver wrapper types print their value (DuckDB decimals); plain objects print [object Object].
    const s = String(v);
    if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  }
  const s = String(v);
  // A driver may hand back "1.50" where the other says "1.5"; same number, same meaning.
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
}

/**
 * Each port of Chinook spells its identifiers differently: Postgres ships snake_case, MySQL and
 * SQLite PascalCase, Oracle folds unquoted DDL to upper case. Comparing on a normalised form keeps
 * the check about the data rather than about the spelling.
 */
const normalize = (n) => String(n).toLowerCase().replace(/_/g, '');

/**
 * The same five business questions in each dialect. They are chosen to exercise joins, grouping,
 * money arithmetic, an anti-join, and text carrying accents and apostrophes.
 */
function queriesFor({ t, c, limit }) {
  const q = (name, sql) => ({ name, sql });
  return [
    q(
      'top artists by tracks',
      limit(
        `SELECT ar.${c('Name')} AS artist, COUNT(*) AS tracks
        FROM ${t('Track')} tr
        JOIN ${t('Album')} al ON al.${c('AlbumId')} = tr.${c('AlbumId')}
        JOIN ${t('Artist')} ar ON ar.${c('ArtistId')} = al.${c('ArtistId')}
        GROUP BY ar.${c('Name')} ORDER BY tracks DESC, artist ASC`,
        10,
      ),
    ),
    q(
      'revenue by country',
      limit(
        `SELECT ${c('BillingCountry')} AS country, SUM(${c('Total')}) AS revenue, COUNT(*) AS invoices
        FROM ${t('Invoice')} GROUP BY ${c('BillingCountry')} ORDER BY revenue DESC, country ASC`,
        15,
      ),
    ),
    q(
      'customers without invoices',
      limit(
        `SELECT cu.${c('CustomerId')} AS id, cu.${c('LastName')} AS surname
        FROM ${t('Customer')} cu LEFT JOIN ${t('Invoice')} i ON i.${c('CustomerId')} = cu.${c('CustomerId')}
        WHERE i.${c('CustomerId')} IS NULL ORDER BY id`,
        20,
      ),
    ),
    q(
      'longest tracks',
      limit(
        `SELECT ${c('Name')} AS track, ${c('Milliseconds')} AS ms, ${c('UnitPrice')} AS price
        FROM ${t('Track')} ORDER BY ms DESC, track ASC`,
        10,
      ),
    ),
    // Accents and apostrophes are where a lossy encoding path shows up.
    q(
      'accented and quoted names',
      limit(
        `SELECT ${c('Name')} AS track FROM ${t('Track')}
        WHERE ${c('Name')} LIKE '%''%' OR ${c('Name')} LIKE '%ó%' OR ${c('Name')} LIKE '%ç%'
        ORDER BY track`,
        25,
      ),
    ),
  ];
}

/** Statements that must never run. Each is a plausible thing a model could emit. */
const WRITE_ATTEMPTS = (t) => [
  ['delete', `DELETE FROM ${t('Track')}`],
  ['update', `UPDATE ${t('Track')} SET ${t('Name')} = 'x'`],
  ['insert', `INSERT INTO ${t('Genre')} (GenreId, Name) VALUES (999, 'x')`],
  ['drop', `DROP TABLE ${t('Album')}`],
  ['truncate', `TRUNCATE TABLE ${t('Album')}`],
  ['stacked', `SELECT 1; DROP TABLE ${t('Album')}`],
  ['cte write', `WITH d AS (DELETE FROM ${t('Track')} RETURNING 1) SELECT * FROM d`],
  ['comment smuggled', `SELECT 1 /* x */; DELETE FROM ${t('Track')}`],
];

const MONGO_WRITE_ATTEMPTS = [
  ['$out', '[{"$match":{}},{"$out":"Track"}]'],
  ['$merge', '[{"$merge":{"into":"Track"}}]'],
  ['$where', '[{"$match":{"$where":"1==1"}}]'],
  ['$function', '[{"$addFields":{"x":{"$function":{"body":"function(){return 1}","args":[],"lang":"js"}}}}]'],
];

/** PascalCase to the snake_case the Postgres port of Chinook actually uses. */
const pgIdent = (n) => `"${n.replace(/(?<=[a-z])(?=[A-Z])/g, '_').toLowerCase()}"`;
const passthrough = (n) => `"${n}"`;
const upper = (n) => `"${n.toUpperCase()}"`;
const backtick = (n) => `\`${n}\``;
const withLimit = (sql, n) => `${sql} LIMIT ${n}`;

const ENGINES = [
  {
    key: 'postgres',
    connector: () => new PostgresConnector({ id: 'p', name: 'p', connectionString: PG_URL }),
    ident: { t: pgIdent, c: pgIdent, limit: withLimit },
    raw: async (sql) => {
      const { default: pg } = await import('pg');
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      try {
        const r = await c.query(sql);
        return r.rows.map((row) => r.fields.map((f) => row[f.name]));
      } finally {
        await c.end();
      }
    },
  },
  {
    key: 'mysql',
    connector: () => new MysqlConnector({ id: 'm', name: 'm', ...MY }),
    ident: { t: backtick, c: backtick, limit: withLimit },
    raw: async (sql) => {
      const mysql = await import(new URL('../packages/mysql/node_modules/mysql2/promise.js', import.meta.url).href);
      const c = await mysql.createConnection({ ...MY, supportBigNumbers: true, bigNumberStrings: true });
      try {
        const [rows, fields] = await c.query(sql);
        return rows.map((row) => fields.map((f) => row[f.name]));
      } finally {
        await c.end();
      }
    },
  },
  {
    key: 'sqlite',
    connector: () => new SqliteConnector({ id: 's', name: 's', file: SQLITE_FILE }),
    ident: { t: passthrough, c: passthrough, limit: withLimit },
    raw: (sql) => {
      const db = new DatabaseSync(SQLITE_FILE, { readOnly: true });
      try {
        return db
          .prepare(sql)
          .all()
          .map((r) => Object.values(r));
      } finally {
        db.close();
      }
    },
  },
  {
    key: 'duckdb',
    connector: () => new DuckDbConnector({ id: 'd', name: 'd', path: DUCK_FILE }),
    ident: { t: passthrough, c: passthrough, limit: withLimit },
    raw: async (sql) => {
      const { DuckDBInstance } = await import(
        new URL('../packages/duckdb/node_modules/@duckdb/node-api/lib/index.js', import.meta.url).href
      );
      const inst = await DuckDBInstance.create(DUCK_FILE);
      const conn = await inst.connect();
      const res = await conn.runAndReadAll(sql);
      return res.getRows();
    },
  },
  {
    key: 'oracle',
    connector: () => new OracleConnector({ id: 'o', name: 'o', ...ORA }),
    // Unquoted DDL folds to upper case, and Oracle 12c+ spells LIMIT as FETCH FIRST.
    ident: { t: upper, c: upper, limit: (sql, n) => `${sql} FETCH FIRST ${n} ROWS ONLY` },
    raw: async (sql) => {
      const oracledb = await import(new URL('../packages/oracle/node_modules/oracledb/index.js', import.meta.url).href);
      const c = await oracledb.default.getConnection(ORA);
      try {
        return (await c.execute(sql)).rows;
      } finally {
        await c.close();
      }
    },
  },
];

const results = [];
let failures = 0;
const fail = (engine, check, detail) => {
  failures++;
  results.push([engine, check, 'FAIL', detail]);
};
const pass = (engine, check, detail) => results.push([engine, check, 'ok', detail]);

for (const engine of ENGINES) {
  let connector;
  try {
    connector = engine.connector();
    await connector.connect();
    const { t, c } = engine.ident;

    // ---- 1. introspection against a schema nobody here designed ----
    const catalog = await connector.introspect();
    const tables = catalog.tables ?? [];
    const names = new Set(tables.map((x) => normalize(x.name)));
    const expected = [
      'Album',
      'Artist',
      'Customer',
      'Employee',
      'Genre',
      'Invoice',
      'InvoiceLine',
      'MediaType',
      'Playlist',
      'PlaylistTrack',
      'Track',
    ];
    const missing = expected.filter((n) => !names.has(normalize(n)));
    const trackTable = tables.find((x) => normalize(x.name) === 'track');
    const trackCols = new Set((trackTable?.columns ?? []).map((x) => normalize(x.name)));
    const missingCols = ['TrackId', 'Name', 'AlbumId', 'Milliseconds', 'UnitPrice'].filter(
      (n) => !trackCols.has(normalize(n)),
    );
    if (missing.length || missingCols.length) {
      fail(engine.key, 'introspect', `missing tables [${missing}] columns [${missingCols}]`);
    } else {
      pass(engine.key, 'introspect', `${tables.length} tables, Track has ${trackCols.size} columns`);
    }

    // ---- 2. the same real questions through both paths ----
    let cells = 0;
    const diffs = [];
    for (const { name, sql } of queriesFor(engine.ident)) {
      const mine = (await connector.execute(sql)).rows.map((r) => r.map(canon));
      const theirs = (await engine.raw(sql)).map((r) => r.map(canon));
      if (mine.length !== theirs.length) {
        diffs.push(`${name}: ${theirs.length} rows from the driver, ${mine.length} from AskSQL`);
        continue;
      }
      for (let r = 0; r < theirs.length; r++) {
        for (let i = 0; i < theirs[r].length; i++) {
          cells++;
          if (mine[r]?.[i] !== theirs[r][i]) {
            diffs.push(
              `${name} row ${r} col ${i}: driver ${JSON.stringify(theirs[r][i])} vs asksql ${JSON.stringify(mine[r]?.[i])}`,
            );
          }
        }
      }
    }
    if (diffs.length) fail(engine.key, 'fidelity', diffs.slice(0, 3).join('; '));
    else pass(engine.key, 'fidelity', `${cells} cells identical across 5 queries`);

    // ---- 3. writes refused, and the data is provably untouched ----
    const countSql = `SELECT COUNT(*) FROM ${t('Track')}`;
    const before = canon((await engine.raw(countSql))[0][0]);
    const accepted = [];
    for (const [label, sql] of WRITE_ATTEMPTS(t)) {
      const verdict = guardSql({ sql, dialect: connector.dialect });
      if (!verdict.allowed) continue;
      accepted.push(`guard allowed ${label}`);
      // The guard is the boundary under test; if it ever allows a write, the engine must still refuse.
      try {
        await connector.execute(verdict.sql);
        accepted.push(`${label} EXECUTED`);
      } catch {
        /* the read-only session refused it, which is the backstop working */
      }
    }
    const after = canon((await engine.raw(countSql))[0][0]);
    if (accepted.length) fail(engine.key, 'read-only', accepted.join('; '));
    else if (before !== after) fail(engine.key, 'read-only', `Track rows changed: ${before} -> ${after}`);
    else pass(engine.key, 'read-only', `${WRITE_ATTEMPTS(t).length} writes refused, Track still ${after} rows`);
  } catch (err) {
    fail(engine.key, 'connect', (err.userMessage ?? err.message ?? String(err)).split('\n')[0].slice(0, 90));
  } finally {
    await connector?.close?.().catch(() => {});
  }
}

// ---- MongoDB: a different guard and no SQL, so it is checked on its own terms ----
{
  let connector;
  try {
    connector = new MongodbConnector({
      id: 'g',
      name: 'g',
      connectionString: `${MONGO_URL}/asksql_e2e`,
      database: 'asksql_e2e',
    });
    await connector.connect();

    const catalog = await connector.introspect();
    const names = new Set((catalog.tables ?? []).map((x) => normalize(x.name)));
    const missing = ['Track', 'Album', 'Artist', 'Invoice'].filter((n) => !names.has(normalize(n)));
    if (missing.length) fail('mongodb', 'introspect', `missing collections [${missing}]`);
    else pass('mongodb', 'introspect', `${catalog.tables.length} collections`);

    const { MongoClient } = await import(
      new URL('../packages/mongodb/node_modules/mongodb/lib/index.js', import.meta.url).href
    );
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db('asksql_e2e');

    const pipelines = [
      [
        'count by genre',
        'Track',
        [{ $group: { _id: '$GenreId', n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 10 }],
      ],
      [
        'revenue by country',
        'Invoice',
        [
          { $group: { _id: '$BillingCountry', total: { $sum: '$Total' } } },
          { $sort: { total: -1, _id: 1 } },
          { $limit: 15 },
        ],
      ],
      [
        'longest tracks',
        'Track',
        [{ $sort: { Milliseconds: -1, Name: 1 } }, { $limit: 10 }, { $project: { _id: 0, Name: 1, Milliseconds: 1 } }],
      ],
    ];
    let cells = 0;
    const diffs = [];
    for (const [name, coll, pipeline] of pipelines) {
      const mine = await connector.aggregate(coll, pipeline);
      const theirs = await db.collection(coll).aggregate(pipeline).toArray();
      const mineRows = mine.rows.map((r) => r.map(canon));
      const theirRows = theirs.map((doc) => mine.columns.map((col) => canon(doc[col.name])));
      if (mineRows.length !== theirRows.length) {
        diffs.push(`${name}: ${theirRows.length} docs from the driver, ${mineRows.length} from AskSQL`);
        continue;
      }
      for (let r = 0; r < theirRows.length; r++) {
        for (let i = 0; i < theirRows[r].length; i++) {
          cells++;
          if (mineRows[r]?.[i] !== theirRows[r][i]) {
            diffs.push(
              `${name} row ${r} col ${i}: driver ${JSON.stringify(theirRows[r][i])} vs asksql ${JSON.stringify(mineRows[r]?.[i])}`,
            );
          }
        }
      }
    }
    if (diffs.length) fail('mongodb', 'fidelity', diffs.slice(0, 3).join('; '));
    else pass('mongodb', 'fidelity', `${cells} cells identical across 3 pipelines`);

    const before = await db.collection('Track').countDocuments();
    const accepted = [];
    for (const [label, json] of MONGO_WRITE_ATTEMPTS) {
      if (guardPipeline(json).allowed) accepted.push(`guard allowed ${label}`);
    }
    const after = await db.collection('Track').countDocuments();
    if (accepted.length) fail('mongodb', 'read-only', accepted.join('; '));
    else if (before !== after) fail('mongodb', 'read-only', `Track docs changed: ${before} -> ${after}`);
    else pass('mongodb', 'read-only', `${MONGO_WRITE_ATTEMPTS.length} stages refused, Track still ${after} docs`);

    await client.close();
  } catch (err) {
    fail('mongodb', 'connect', (err.userMessage ?? err.message ?? String(err)).split('\n')[0].slice(0, 90));
  } finally {
    await connector?.close?.().catch(() => {});
  }
}

console.log('\n### Live databases, real schema (Chinook)\n');
console.log('| Engine | Check | Result | Detail |');
console.log('|---|---|---|---|');
for (const [e, check, verdict, detail] of results) console.log(`| ${e} | ${check} | ${verdict} | ${detail} |`);
console.log(
  failures === 0 ? `\nAll ${results.length} checks passed on 6 live engines.` : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
