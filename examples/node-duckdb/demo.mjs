/**
 * Zero-backend file analytics demo (headless).
 *
 * Registers a CSV as a DuckDB table, then asks natural-language questions
 * with a real model - Groq if GROQ_API_KEY is set, else local Ollama.
 * Everything runs in this process; nothing leaves the machine except the
 * schema-only prompt to your chosen LLM.
 *
 *   GROQ_API_KEY=... node examples/node-duckdb/demo.mjs
 *   node examples/node-duckdb/demo.mjs           # uses local Ollama
 */
import { createAskSql, resolveModel } from '@asksql/core';
import { DuckDbConnector } from '@asksql/duckdb';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));

async function pickModel() {
  if (process.env.GROQ_API_KEY) {
    console.log('· model: Groq llama-3.3-70b-versatile');
    return resolveModel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: process.env.GROQ_API_KEY });
  }
  console.log('· model: local Ollama qwen2.5-coder:14b');
  return resolveModel({ provider: 'ollama', model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:14b', baseURL: 'http://localhost:11434/v1' });
}

async function main() {
  const connector = new DuckDbConnector({
    id: 'files',
    name: 'Uploaded files',
    files: [{ table: 'sales', path: join(dir, 'sales.csv'), format: 'csv' }],
  });
  const model = await pickModel();
  const engine = createAskSql({ connectors: [connector], model, policy: { maxRows: 100 }, llm: { timeoutMs: 120_000 } });

  const questions = [
    'Which region has the highest total sales amount?',
    'How many orders did each customer place, most first?',
    'What is the average order amount, rounded to 2 decimals?',
  ];

  for (const q of questions) {
    console.log(`\n❓ ${q}`);
    const res = await engine.ask(q);
    console.log(`💬 ${res.explanation || '(no explanation)'}`);
    console.log(`📝 ${res.sql}`);
    const out = await res.run();
    const header = out.columns.map((c) => c.name).join(' | ');
    console.log(`📊 ${header}`);
    for (const row of out.rows.slice(0, 5)) console.log(`   ${row.map((v) => (v === null ? 'NULL' : v)).join(' | ')}`);
  }

  await engine.close();
  console.log('\n✅ done');
}

main().catch((err) => {
  console.error('❌', err.code ?? '', err.userMessage ?? err.message);
  process.exit(1);
});
