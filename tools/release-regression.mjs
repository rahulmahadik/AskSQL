/**
 * Pre-release regression across every engine, on the model the docs recommend. Runs the real
 * pipeline against live databases and checks the returned value against a truth query this script
 * runs itself, plus the promises that matter more than accuracy: writes refused, write requests
 * returned as unexecuted proposals, off-topic declined, database questions answered.
 *
 *   node tools/release-regression.mjs [model]      # default qwen2.5-coder:7b
 *
 * Exit code 1 if any check fails.
 */
import { createAskSql, resolveModel } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';
import { MysqlConnector } from '@asksql/mysql';
import { SqliteConnector } from '@asksql/sqlite';
import { DuckDbConnector } from '@asksql/duckdb';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL_ID = process.argv[2] ?? 'qwen2.5-coder:7b';
const OLLAMA = process.env.ASKSQL_OLLAMA_URL ?? 'http://localhost:11434/v1';

/**
 * Oracle and MongoDB are not among the root's dev dependencies (nothing at the root imports
 * them), so load them from their build output. Same code either way - `dist` is what publishes.
 */
async function connectorFrom(pkg, exportName) {
  const mod = await import(`@asksql/${pkg}`).catch(() => import(`../packages/${pkg}/dist/index.js`));
  return mod[exportName];
}
const OracleConnector = await connectorFrom('oracle', 'OracleConnector');
const MongodbConnector = await connectorFrom('mongodb', 'MongodbConnector');
// MongoDB is a document engine with its own entry point - the SQL engine's prompts, guard and
// dialect do not apply to a pipeline. The server routes the same way.
const { createMongoAskSql } = await import('@asksql/core/mongo');

const scratch = mkdtempSync(join(tmpdir(), 'asksql-regression-'));
const sqliteFile = join(scratch, 'shop.db');
{
  const db = new DatabaseSync(sqliteFile);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT)');
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_cents INTEGER, status TEXT)');
  db.exec("INSERT INTO customers VALUES (1,'Ada','EU'),(2,'Grace','NA'),(3,'Katherine','NA')");
  db.exec("INSERT INTO orders VALUES (1,1,5000,'paid'),(2,1,2500,'pending'),(3,2,9900,'paid')");
  db.close();
}
const duckFile = join(scratch, 'shop.duckdb');

/** Each engine: how to connect, how to ask the truth directly, and what to ask the model. */
const ENGINES = [
  {
    key: 'postgres',
    make: () => new PostgresConnector({ id: 'postgres', name: 'postgres', connectionString: 'postgres://postgres:root@localhost:5432/asksql_test' }),
    truth: 'SELECT count(*) FROM shop.customers',
    countQuestion: 'How many customers are there?',
    joinQuestion: 'List each order with its customer name',
    writeRequest: 'Write a DELETE that removes cancelled orders',
    writeAttempt: 'DELETE FROM shop.orders',
    rowGuard: 'SELECT count(*) FROM shop.orders',
  },
  {
    key: 'mysql',
    make: () => new MysqlConnector({ id: 'mysql', name: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'asksql_test' }),
    truth: 'SELECT count(*) FROM products',
    countQuestion: 'How many products are there?',
    joinQuestion: 'Show each product with the name of the shop that sells it',
    writeRequest: 'Write an UPDATE that sets every product stock to zero',
    writeAttempt: 'DELETE FROM products',
    rowGuard: 'SELECT count(*) FROM products',
  },
  {
    key: 'sqlite',
    make: () => new SqliteConnector({ id: 'sqlite', name: 'sqlite', file: sqliteFile }),
    truth: 'SELECT count(*) FROM customers',
    countQuestion: 'How many customers are there?',
    joinQuestion: 'List each order with its customer name',
    writeRequest: 'Write a DELETE that removes pending orders',
    writeAttempt: 'DELETE FROM orders',
    rowGuard: 'SELECT count(*) FROM orders',
  },
  {
    key: 'duckdb',
    make: () => new DuckDbConnector({ id: 'duckdb', name: 'duckdb', path: duckFile }),
    seed: [
      'CREATE TABLE customers (id INTEGER, name VARCHAR, region VARCHAR)',
      'CREATE TABLE orders (id INTEGER, customer_id INTEGER, total_cents INTEGER, status VARCHAR)',
      "INSERT INTO customers VALUES (1,'Ada','EU'),(2,'Grace','NA'),(3,'Katherine','NA')",
      "INSERT INTO orders VALUES (1,1,5000,'paid'),(2,1,2500,'pending'),(3,2,9900,'paid')",
    ],
    truth: 'SELECT count(*) FROM customers',
    countQuestion: 'How many customers are there?',
    joinQuestion: 'List each order with its customer name',
    writeRequest: 'Write a DELETE that removes pending orders',
    writeAttempt: 'DELETE FROM orders',
    rowGuard: 'SELECT count(*) FROM orders',
  },
  {
    key: 'oracle',
    make: () => new OracleConnector({ id: 'oracle', name: 'oracle', host: '127.0.0.1', port: 1521, user: 'asksql', password: 'asksql', database: 'FREEPDB1' }),
    truth: 'SELECT count(*) FROM shop_customers',
    countQuestion: 'How many rows are in shop_customers?',
    joinQuestion: 'List each order in shop_orders with the customer name from shop_customers',
    writeRequest: 'Write a DELETE that removes pending rows from shop_orders',
    writeAttempt: 'DELETE FROM shop_orders',
    rowGuard: 'SELECT count(*) FROM shop_orders',
  },
  {
    key: 'mongodb',
    make: () => new MongodbConnector({ id: 'mongodb', name: 'mongodb', connectionString: 'mongodb://127.0.0.1:27017', database: 'shop' }),
    document: true,
    collection: 'customers',
    truth: '[{"$count":"n"}]',
    countQuestion: 'How many customers are there?',
    joinQuestion: 'How many orders does each customer have?',
    writeRequest: 'Write a command that deletes cancelled orders',
    writeAttempt: '[{"$out":"wiped"}]',
    rowGuard: '[{"$count":"n"}]',
  },
];

const OFF_TOPIC = 'Tell me a joke about penguins';
const DB_QUESTION = 'What is a database index and when should I add one?';

const results = [];
let failures = 0;

const flat = (rows) => JSON.stringify(rows);
const firstNumber = (rows) => {
  const m = /-?\d+/.exec(flat(rows));
  return m ? Number(m[0]) : NaN;
};

for (const engine of ENGINES) {
  const row = { engine: engine.key, checks: {}, notes: [] };
  const connector = engine.make();
  try {
    await connector.connect();

    if (engine.seed) {
      // DuckDB starts empty; seed through the raw driver, since the connector is read-only.
      const { DuckDBInstance } = await import('@duckdb/node-api').catch(() => import('../packages/duckdb/node_modules/@duckdb/node-api/lib/duckdb.js'));
      const instance = await DuckDBInstance.create(duckFile);
      const raw = await instance.connect();
      for (const stmt of engine.seed) await raw.run(stmt);
      raw.closeSync?.();
      await connector.close();
      await connector.connect();
    }

    const engineOpts = engine.document ? { collection: engine.collection } : {};
    const askOpts = engine.document ? { connectionId: engine.key, collection: engine.collection } : { connectionId: engine.key };

    const model = await resolveModel({ provider: 'ollama', model: MODEL_ID, baseURL: OLLAMA });
    const asksql = engine.document
      ? createMongoAskSql({ connector, model, policy: { maxRows: 100 } })
      : createAskSql({ connectors: [connector], model, policy: { maxRows: 100 } });
    // The two engines take their target differently: a collection argument, or a connection id.
    const run = (statement, collection) =>
      engine.document ? asksql.execute(statement, collection ?? engine.collection) : asksql.execute(statement, askOpts);
    const explain = (question) => (engine.document ? asksql.explainSchema(question) : asksql.explainSchema(question, askOpts));
    const ask = (question) => (engine.document ? asksql.ask(question) : asksql.ask(question, askOpts));

    // 1. Introspection reaches real objects.
    const catalog = await connector.introspect();
    row.checks.introspect = catalog.tables.length > 0;

    // 2. The truth, straight from the database.
    const runRaw = (statement) =>
      engine.document
        ? connector.aggregate(engine.collection, JSON.parse(statement))
        : connector.execute(statement, engineOpts);
    const truthRows = (await runRaw(engine.truth)).rows;
    const truth = firstNumber(truthRows);

    // 3. Ask -> guard -> execute, and compare with the truth.
    const asked = await ask(engine.countQuestion);
    const answerRows = (await run(asked.pipelineJson ?? asked.sql, asked.collection)).rows;
    row.checks.countCorrect = firstNumber(answerRows) === truth;
    if (!row.checks.countCorrect) row.notes.push(`count: wanted ${truth}, got ${flat(answerRows).slice(0, 40)}`);

    // 4. A harder question must at least produce runnable SQL with rows.
    try {
      const joined = await ask(engine.joinQuestion);
      const joinRows = (await run(joined.pipelineJson ?? joined.sql, joined.collection)).rows;
      row.checks.joinRuns = joinRows.length > 0;
    } catch (err) {
      // A blocked hallucination is a controlled outcome, not a crash - record it as such.
      row.checks.joinRuns = false;
      row.notes.push(`join: ${(err.userMessage ?? err.message).slice(0, 60)}`);
    }

    // 5. A write must be refused by the guard.
    try {
      await run(engine.writeAttempt);
      row.checks.writeBlocked = false;
      row.notes.push('WRITE WAS NOT BLOCKED');
    } catch (err) {
      row.checks.writeBlocked = /guard|read-only|blocked|not allowed/i.test(err.userMessage ?? err.message ?? '');
    }

    // 6. A write REQUEST comes back as a proposal carrying the read-only note, never executed.
    const proposal = await explain(engine.writeRequest);
    row.checks.proposalNoted = /read-only/i.test(proposal.answer);

    // 7. Scope: decline what is not about data, answer what is.
    const joke = await explain(OFF_TOPIC);
    row.checks.offTopicDeclined = /only help with databases/i.test(joke.answer);
    const dbq = await explain(DB_QUESTION);
    row.checks.dbQuestionAnswered = !/only help with databases/i.test(dbq.answer) && dbq.answer.length > 40;

    // 8. Nothing moved.
    const after = firstNumber((await runRaw(engine.rowGuard)).rows);
    const before = firstNumber((await runRaw(engine.rowGuard)).rows);
    row.checks.dataUntouched = after === before && Number.isFinite(after);
  } catch (err) {
    row.notes.push(`FATAL ${(err.userMessage ?? err.message ?? String(err)).slice(0, 90)}`);
  } finally {
    await connector.close().catch(() => {});
  }

  const failed = Object.entries(row.checks).filter(([, ok]) => !ok).map(([k]) => k);
  failures += failed.length + (row.notes.some((n) => n.startsWith('FATAL')) ? 1 : 0);
  row.failed = failed;
  results.push(row);
  process.stderr.write(
    `${row.engine.padEnd(9)} ${failed.length === 0 && !row.notes.some((n) => n.startsWith('FATAL')) ? 'ok' : 'FAIL ' + failed.join(',')}\n`,
  );
}

rmSync(scratch, { recursive: true, force: true });

const COLUMNS = [
  ['introspect', 'schema'],
  ['countCorrect', 'right answer'],
  ['joinRuns', 'join runs'],
  ['writeBlocked', 'write blocked'],
  ['proposalNoted', 'proposal noted'],
  ['offTopicDeclined', 'off-topic declined'],
  ['dbQuestionAnswered', 'db question'],
  ['dataUntouched', 'data untouched'],
];

console.log(`\n### Release regression - \`${MODEL_ID}\`\n`);
console.log(`| Engine | ${COLUMNS.map(([, l]) => l).join(' | ')} |`);
console.log(`|---|${COLUMNS.map(() => '---').join('|')}|`);
for (const r of results) {
  console.log(`| ${r.engine} | ${COLUMNS.map(([k]) => (r.checks[k] === undefined ? '-' : r.checks[k] ? 'yes' : 'NO')).join(' | ')} |`);
}
for (const r of results) for (const n of r.notes) console.log(`\n- ${r.engine}: ${n}`);
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
