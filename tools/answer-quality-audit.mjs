/**
 * Valid SQL that returns a wrong number, which the guard cannot catch. A rate over repeated
 * trials, not a gate: the numbers move with the model.
 *
 *   node tools/answer-quality-audit.mjs [model] [trials]
 */
import { createAskSql, resolveModel } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';

const MODEL_ID = process.argv[2] ?? 'qwen2.5-coder:7b';
const TRIALS = Number(process.argv[3] ?? 10);
const OLLAMA = process.env.ASKSQL_OLLAMA_URL ?? 'http://localhost:11434/v1';
const PG_URL = process.env.ASKSQL_PG_URL ?? 'postgres://postgres:root@localhost:5432/asksql_test';

/** Fixture truths in cents; an answer may report either unit. */
const ADA_TRUE = 1_000_000_249_999;
const ADA_FANNED_OUT = 2_000_000_249_998; // each order counted once per line item
const TOTAL_TRUE = 1_000_000_254_999;

/** Matches the target in either unit. */
const matches = (value, target) =>
  Math.abs(value - target) < 1 || Math.abs(value - target / 100) < 0.01 || Math.abs(value * 100 - target) < 1;

const TRAPS = [
  {
    name: 'revenue for one customer is not inflated by line items',
    question: 'What is the total revenue for Ada Lovelace?',
    verdict: (values) => values.some((v) => matches(v, ADA_TRUE)) && !values.some((v) => matches(v, ADA_FANNED_OUT)),
  },
  {
    name: 'revenue is not inflated when asked alongside a line-item count',
    question: 'For each customer, show total revenue and how many line items they ordered.',
    // Absence of the inflated figure is not enough: summing line items avoids it and is also wrong.
    verdict: (values) => values.some((v) => matches(v, ADA_TRUE)) && !values.some((v) => matches(v, ADA_FANNED_OUT)),
  },
  {
    name: 'a cents column is converted or labelled, never reported as dollars',
    question: 'What is our total revenue in dollars?',
    verdict: (values, sql) => values.some((v) => Math.abs(v - TOTAL_TRUE / 100) < 1) || /\/\s*100|cents/i.test(sql),
  },
];

const connector = new PostgresConnector({ id: 'shop', name: 'Shop', connectionString: PG_URL });
await connector.connect();
const model = await resolveModel({ provider: 'ollama', model: MODEL_ID, baseURL: OLLAMA });
const asksql = createAskSql({ connectors: [connector], model, policy: { maxRows: 100 }, llm: { timeoutMs: 120_000 } });

const rows = [];
for (const trap of TRAPS) {
  let correct = 0;
  const wrong = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const answer = await asksql.ask(trap.question);
      const result = await answer.run();
      const values = result.rows.flat().map(Number).filter(Number.isFinite);
      if (trap.verdict(values, answer.sql)) correct++;
      else wrong.push(answer.sql.replace(/\s+/g, ' ').trim());
    } catch (err) {
      wrong.push(`ERROR ${err?.code ?? ''} ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }
  rows.push({ trap, correct, wrong });
  console.log(`${correct}/${TRIALS}  ${trap.name}`);
}

console.log(`\n### Answer-quality audit - \`${MODEL_ID}\`, ${TRIALS} trials each\n`);
console.log('| Trap | Correct |');
console.log('|---|---|');
for (const { trap, correct } of rows) console.log(`| ${trap.name} | ${correct}/${TRIALS} |`);

for (const { trap, wrong } of rows) {
  if (wrong.length === 0) continue;
  console.log(`\nWrong answers for "${trap.name}":`);
  for (const sql of [...new Set(wrong)].slice(0, 3)) console.log(`  ${sql.slice(0, 200)}`);
}

await connector.close();
