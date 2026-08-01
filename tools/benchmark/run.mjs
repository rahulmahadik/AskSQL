/**
 * Reproduces the model comparison published in the README.
 *
 * It asks the same questions of each model against the repo's own test fixtures, executes the
 * SQL that comes back, and looks for the expected value in the rows the database returned - so a
 * model that emits unrunnable SQL, or runs something that answers a different question, scores 0.
 * The check is a substring match over the returned rows, not an exact-shape assertion.
 *
 *   psql -U postgres -d asksql_test -f packages/postgres/test/fixture.sql
 *   mysql -uroot asksql_test < packages/mysql/test/fixture.sql
 *   node tools/benchmark/run.mjs qwen2.5-coder:1.5b qwen2.5-coder:7b qwen2.5-coder:14b
 *
 * Connection details come from the same env vars the live test suites use.
 */
import { createAskSql, resolveModel } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';
import { MysqlConnector } from '@asksql/mysql';

const MODELS = process.argv.slice(2);
if (MODELS.length === 0) {
  console.error('usage: node tools/benchmark/run.mjs <model> [model...]');
  process.exit(1);
}

const PG_URL = process.env.ASKSQL_PG_URL ?? 'postgres://postgres:root@localhost:5432/asksql_test';
const MYSQL = {
  host: process.env.ASKSQL_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.ASKSQL_MYSQL_PORT ?? 3306),
  user: process.env.ASKSQL_MYSQL_USER ?? 'root',
  password: process.env.ASKSQL_MYSQL_PASSWORD ?? '',
  database: process.env.ASKSQL_MYSQL_DB ?? 'asksql_test',
};
const OLLAMA = process.env.ASKSQL_OLLAMA_URL ?? 'http://localhost:11434/v1';

/**
 * question -> [expected substring in the returned rows, exact row count a right answer has].
 * The row count is what makes this a real check: the fixtures are small enough that a
 * `SELECT * FROM <the right table>` would contain most of these strings by accident, so a
 * dump that answers nothing scores 0 on the count even when the substring is present.
 */
const SQL_CASES = [
  ['pg', 'How many customers are there?', '3', 1],
  ['pg', 'Which customer has spent the most on paid orders?', 'ada', 1],
  ['pg', 'How many customers are in each region?', 'EU', 2],
  ['pg', 'List each order with its customer name', 'Ada', 4],
  ['mysql', 'What is the most expensive product?', 'Widget', 1],
  ['mysql', 'Which shop has the most products?', 'North Store', 1],
  ['mysql', 'Which products are out of stock?', 'Gadget', 1],
];

/** question -> should AskSQL decline it as outside databases? */
const SCOPE_CASES = [
  ['Tell me a joke about penguins', true],
  ['What is the weather in Mumbai today?', true],
  ['Who won the world cup in 2022?', true],
  ['Write me a python function that reverses a string', true],
  ['What is this database for?', false],
  ['What is a database index and when should I add one?', false],
  ['How do I write a SQL JOIN here?', false],
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function benchmark(modelId) {
  const model = await resolveModel({ provider: 'ollama', model: modelId, baseURL: OLLAMA });
  const pg = new PostgresConnector({ id: 'pg', name: 'pg', connectionString: PG_URL });
  const mysql = new MysqlConnector({ id: 'mysql', name: 'mysql', ...MYSQL });
  const engine = createAskSql({ connectors: [pg, mysql], model, policy: { maxRows: 50 } });

  const row = { model: modelId, sqlOk: 0, sqlBlocked: 0, scopeOk: 0, genSecs: [], scopeSecs: [], proposal: {} };

  for (const [conn, question, expect, rowCount] of SQL_CASES) {
    const started = Date.now();
    try {
      const asked = await engine.ask(question, { connectionId: conn });
      const result = await engine.execute(asked.sql, { connectionId: conn });
      row.genSecs.push((Date.now() - started) / 1000);
      const flat = JSON.stringify(result.rows).toLowerCase();
      if (result.rows.length === rowCount && flat.includes(expect.toLowerCase())) row.sqlOk++;
    } catch (err) {
      row.genSecs.push((Date.now() - started) / 1000);
      // A refusal here is the hallucination floor: the model invented a name and AskSQL
      // stopped it before the database saw it. Reported separately from a wrong answer.
      if (/does not exist|nothing was run/i.test(err.userMessage ?? '')) row.sqlBlocked++;
      else console.error(`  ${modelId} ${question}: ${err.userMessage ?? err.message}`);
    }
  }

  for (const [question, shouldDecline] of SCOPE_CASES) {
    const started = Date.now();
    const answer = (await engine.explainSchema(question, { connectionId: 'pg' })).answer;
    row.scopeSecs.push((Date.now() - started) / 1000);
    if (/only help with databases/i.test(answer) === shouldDecline) row.scopeOk++;
  }

  // Whether a write statement comes back at all is a model behaviour; the "never executed" note
  // beside it is appended by AskSQL, so that half checks the safety net rather than the model.
  const proposal = await engine.explainSchema('Write a DELETE removing orders older than 2020', { connectionId: 'pg' });
  row.proposal = { statement: /\bdelete\b/i.test(proposal.answer), note: /read-only/i.test(proposal.answer) };

  await Promise.all([pg.close(), mysql.close()]);
  return row;
}

const rows = [];
for (const m of MODELS) {
  process.stderr.write(`benchmarking ${m}...\n`);
  rows.push(await benchmark(m));
}

console.log(`| Model | SQL correct | Blocked by the guard | Scope correct | DELETE request | Median ask | Median schema answer |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const r of rows) {
  const proposal = r.proposal.statement
    ? r.proposal.note
      ? 'statement + note'
      : 'statement, NO note'
    : 'no statement';
  console.log(
    `| \`${r.model}\` | ${r.sqlOk}/${SQL_CASES.length} | ${r.sqlBlocked} | ${r.scopeOk}/${SCOPE_CASES.length} ` +
      `| ${proposal} | ${median(r.genSecs).toFixed(1)}s | ${median(r.scopeSecs).toFixed(1)}s |`,
  );
}
