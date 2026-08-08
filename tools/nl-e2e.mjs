/**
 * Natural-language questions against live databases, through the whole pipeline: question -> model
 * -> generated SQL -> guard -> connector -> real rows. The only harness that starts from a question
 * rather than from SQL somebody wrote.
 *
 *   node tools/nl-e2e.mjs [--model=qwen2.5-coder:7b]
 *
 * Needs Ollama and the Chinook data from tools/real-db-load.mjs. Each question has a known answer
 * computed from the data, so a fluent but wrong answer fails. Exit code 1 on a wrong answer, an
 * altered value, or any change to the stored data.
 *
 * One repair round is allowed and scored `recovered`, matching what the shipped surfaces offer.
 */
import { PostgresConnector } from '@asksql/postgres';
import { MysqlConnector } from '@asksql/mysql';
import { SqliteConnector } from '@asksql/sqlite';
import { DuckDbConnector } from '@asksql/duckdb';
import { createAskSql, resolveModel } from '@asksql/core';
import { createMongoAskSql } from '@asksql/core/mongo';
import { DatabaseSync } from 'node:sqlite';
import { PG_URL, MY, ORA, MONGO_URL, SQLITE_FILE, DUCK_FILE } from './real-db-load.mjs';

const { OracleConnector } = await import(new URL('../packages/oracle/dist/index.js', import.meta.url).href);
const { MongodbConnector } = await import(new URL('../packages/mongodb/dist/index.js', import.meta.url).href);

const MODEL = (process.argv.find((a) => a.startsWith('--model=')) ?? '--model=qwen2.5-coder:7b').slice(8);

/**
 * Answers are facts about the Chinook data, not about a particular query: any correct SQL reaches
 * them. `forbidFloat` marks questions whose answer is an integer id, where 1.0 would be an altered
 * value even though it reads as the same number.
 */
const QUESTIONS = [
  { q: 'How many tracks are in the database?', expect: ['3503'] },
  { q: 'Which artist has the most tracks? Return just the artist name.', expect: ['Iron Maiden'] },
  { q: 'What is the name of the track with the largest Milliseconds value?', expect: ['Occupation / Precipice'] },
  { q: 'How many customers are there?', expect: ['59'] },
  { q: 'Which billing country has the highest total invoice amount? Return just the country.', expect: ['USA'] },
  { q: 'List the first 3 track ids in ascending order.', expect: ['1', '2', '3'], forbidFloat: true },
];

const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return String(v);
};

/** A value that arrived as 1.0 where the database holds 1 has been altered on the way back. */
const looksLikeFloatedInteger = (s) => /^-?\d+\.0+$/.test(s);

/** The corrected query core attaches to a rejected one. Absent unless the database itself rejected it. */
const suggestionAfter = (err) => (err?.code === 'DB_QUERY_ERROR' ? (err.suggestedSql ?? '') : '');

const ENGINES = [
  {
    key: 'postgres',
    connector: () => new PostgresConnector({ id: 'pg', name: 'Chinook', connectionString: PG_URL }),
    count: async () => {
      const { default: pg } = await import('pg');
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      try {
        return String((await c.query('SELECT count(*) FROM track')).rows[0].count);
      } finally {
        await c.end();
      }
    },
  },
  {
    key: 'mysql',
    connector: () => new MysqlConnector({ id: 'my', name: 'Chinook', ...MY }),
    count: async () => {
      const mysql = await import(new URL('../packages/mysql/node_modules/mysql2/promise.js', import.meta.url).href);
      const c = await mysql.createConnection(MY);
      try {
        return String(Object.values((await c.query('SELECT count(*) AS n FROM Track'))[0][0])[0]);
      } finally {
        await c.end();
      }
    },
  },
  {
    key: 'sqlite',
    connector: () => new SqliteConnector({ id: 'sq', name: 'Chinook', file: SQLITE_FILE }),
    count: async () => {
      const db = new DatabaseSync(SQLITE_FILE, { readOnly: true });
      try {
        return String(db.prepare('SELECT count(*) AS n FROM Track').get().n);
      } finally {
        db.close();
      }
    },
  },
  {
    key: 'duckdb',
    connector: () => new DuckDbConnector({ id: 'dk', name: 'Chinook', path: DUCK_FILE }),
    count: async () => {
      const { DuckDBInstance } = await import(
        new URL('../packages/duckdb/node_modules/@duckdb/node-api/lib/index.js', import.meta.url).href
      );
      const conn = await (await DuckDBInstance.create(DUCK_FILE)).connect();
      return String((await conn.runAndReadAll('SELECT count(*) FROM "Track"')).getRows()[0][0]);
    },
  },
  {
    key: 'oracle',
    connector: () => new OracleConnector({ id: 'or', name: 'Chinook', ...ORA }),
    count: async () => {
      const oracledb = await import(new URL('../packages/oracle/node_modules/oracledb/index.js', import.meta.url).href);
      const c = await oracledb.default.getConnection(ORA);
      try {
        return String((await c.execute('SELECT count(*) FROM Track')).rows[0][0]);
      } finally {
        await c.close();
      }
    },
  },
  {
    key: 'mongodb',
    // Pipelines, not SQL: MongoDB has its own engine rather than a dialect of the SQL one.
    mongo: true,
    connector: () =>
      new MongodbConnector({
        id: 'mg',
        name: 'Chinook',
        connectionString: `${MONGO_URL}/asksql_e2e`,
        database: 'asksql_e2e',
      }),
    count: async () => {
      const { MongoClient } = await import(
        new URL('../packages/mongodb/node_modules/mongodb/lib/index.js', import.meta.url).href
      );
      const client = new MongoClient(MONGO_URL);
      await client.connect();
      try {
        return String(await client.db('asksql_e2e').collection('Track').countDocuments());
      } finally {
        await client.close();
      }
    },
  },
];

const model = await resolveModel({ provider: 'ollama', model: MODEL });
const rows = [];
let asked = 0;
let correct = 0;
let recovered = 0;
let wrong = 0;
let altered = 0;
let mutated = 0;
let unreachable = 0;

for (const engine of ENGINES) {
  let connector;
  try {
    connector = engine.connector();
    const askSql = engine.mongo
      ? createMongoAskSql({ connector, model })
      : createAskSql({ connectors: [connector], model });
    const before = await engine.count();

    for (const { q, expect, forbidFloat } of QUESTIONS) {
      asked++;
      let verdict;
      let detail = '';
      try {
        const answer = await askSql.ask(q);
        let repairedFrom = '';
        let result;
        try {
          // The SQL engine hands back a runnable result; the Mongo engine hands back a pipeline.
          result = engine.mongo ? await askSql.execute(answer.pipelineJson, answer.collection) : await answer.run();
        } catch (dbErr) {
          const suggested = suggestionAfter(dbErr);
          if (!suggested) throw dbErr;
          // Guarded again on the way in, the same as the surfaces' re-approval path.
          result = await askSql.execute(suggested);
          repairedFrom = (dbErr.detail ?? dbErr.userMessage ?? dbErr.message ?? '').split('\n')[0].slice(0, 40);
        }
        const cells = (result.rows ?? []).flat().map(cell);
        const missing = expect.filter((want) => !cells.some((c) => c === want || c.includes(want)));
        const floated = forbidFloat ? cells.filter(looksLikeFloatedInteger) : [];

        if (floated.length > 0) {
          verdict = 'ALTERED';
          altered++;
          detail = `integer came back as ${floated.slice(0, 3).join(', ')}`;
        } else if (missing.length > 0) {
          verdict = 'WRONG';
          wrong++;
          detail = `expected ${missing.join(', ')}; got ${cells.slice(0, 4).join(' | ').slice(0, 60)}`;
        } else if (repairedFrom) {
          verdict = 'recovered';
          recovered++;
          detail = `${result.rows.length} rows after repair of: ${repairedFrom}`;
        } else {
          verdict = 'ok';
          correct++;
          detail = `${result.rows.length} rows, ${answer.repairs} repairs`;
        }
      } catch (err) {
        verdict = 'ERROR';
        wrong++;
        detail = (err.userMessage ?? err.message ?? String(err)).split('\n')[0].slice(0, 70);
      }
      rows.push([engine.key, q.slice(0, 44), verdict, detail]);
    }

    const after = await engine.count();
    if (before !== after) {
      mutated++;
      rows.push([engine.key, 'stored data unchanged', 'MUTATED', `Track ${before} -> ${after}`]);
    } else {
      rows.push([engine.key, 'stored data unchanged', 'ok', `Track still ${after}`]);
    }
  } catch (err) {
    rows.push([
      engine.key,
      'connect',
      'ERROR',
      (err.userMessage ?? err.message ?? String(err)).split('\n')[0].slice(0, 70),
    ]);
    unreachable++;
  } finally {
    await connector?.close?.().catch(() => {});
  }
}

console.log(`\n### Natural-language questions against live databases (model: ${MODEL})\n`);
console.log('| Engine | Question | Result | Detail |');
console.log('|---|---|---|---|');
for (const [a, b, c, d] of rows) console.log(`| ${a} | ${b} | ${c} | ${d} |`);

console.log(
  `\n${asked} questions asked: ${correct} correct first try, ${recovered} recovered after one repair, ${wrong} wrong or failed.`,
);
if (altered) console.log(`${altered} ALTERED VALUE(S)`);
if (mutated) console.log(`${mutated} ENGINE(S) HAD DATA CHANGE`);
if (unreachable) console.log(`${unreachable} ENGINE(S) UNREACHABLE`);
process.exit(altered === 0 && mutated === 0 && wrong === 0 && unreachable === 0 ? 0 : 1);
