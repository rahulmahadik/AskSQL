/**
 * Oracle demo (headless).
 *
 * Connects to Oracle with the pure-JS Thin driver (no Oracle client libraries)
 * and asks natural-language questions. Only the schema is sent to the model.
 *
 *   ASKSQL_ORACLE_CONNECT=host:1521/FREEPDB1 \
 *   ASKSQL_ORACLE_USER=system ASKSQL_ORACLE_PASSWORD=... \
 *   GROQ_API_KEY=... node examples/node-oracle/demo.mjs
 *
 * The connect string is Oracle EZConnect: host:port/service_name. A full
 * descriptor or TNS alias works too. Discrete host/port/user/password/database
 * (service) fields are also accepted instead of connectString.
 */
import { createAskSql, resolveModel } from '@asksql/core';
import { OracleConnector } from '@asksql/oracle';

const model = process.env.GROQ_API_KEY
  ? await resolveModel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: process.env.GROQ_API_KEY })
  : await resolveModel({
      provider: 'ollama',
      model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:14b',
      baseURL: 'http://localhost:11434/v1',
    });

const connector = new OracleConnector({
  id: 'hr',
  name: 'HR',
  connectString: process.env.ASKSQL_ORACLE_CONNECT ?? 'localhost:1521/FREEPDB1',
  user: process.env.ASKSQL_ORACLE_USER ?? 'system',
  password: process.env.ASKSQL_ORACLE_PASSWORD ?? 'oracle',
});

const engine = createAskSql({ connectors: [connector], model, policy: { maxRows: 100 }, llm: { timeoutMs: 120_000 } });

for (const q of ['How many employees are in each department?', 'Who are the five highest-paid employees?']) {
  console.log(`\n❓ ${q}`);
  const res = await engine.ask(q);
  console.log(`💬 ${res.explanation || '(no explanation)'}`);
  console.log(`📝 ${res.sql}`);
  const out = await res.run();
  console.log(`📊 ${out.columns.map((c) => c.name).join(' | ')}`);
  for (const row of out.rows.slice(0, 5)) console.log(`   ${row.map((v) => (v === null ? 'NULL' : v)).join(' | ')}`);
}

await engine.close();
console.log('\n✅ done');
