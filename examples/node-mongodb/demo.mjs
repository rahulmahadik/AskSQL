/**
 * MongoDB demo (headless).
 *
 * MongoDB is a non-SQL engine: a question becomes a read-only aggregation
 * pipeline (validated by an allowlist guard), not SQL. Use createMongoAskSql
 * from the '@asksql/core/mongo' subpath with a MongodbConnector.
 *
 *   ASKSQL_MONGO_URL=mongodb://localhost:27017 ASKSQL_MONGO_DB=shop \
 *   GROQ_API_KEY=... node examples/node-mongodb/demo.mjs
 *
 * The connection string is a standard mongodb:// or mongodb+srv:// URI; it
 * carries any credentials. The database to query is passed separately.
 */
import { resolveModel } from '@asksql/core';
import { createMongoAskSql } from '@asksql/core/mongo';
import { MongodbConnector } from '@asksql/mongodb';

const model = process.env.GROQ_API_KEY
  ? await resolveModel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: process.env.GROQ_API_KEY })
  : await resolveModel({
      provider: 'ollama',
      model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:14b',
      baseURL: 'http://localhost:11434/v1',
    });

const connector = new MongodbConnector({
  id: 'shop',
  name: 'Shop',
  connectionString: process.env.ASKSQL_MONGO_URL ?? 'mongodb://localhost:27017',
  database: process.env.ASKSQL_MONGO_DB ?? 'shop',
});

const engine = createMongoAskSql({ connector, model, policy: { maxRows: 100 } });

for (const q of ['How many orders are there per status?', 'What are the five most expensive products?']) {
  console.log(`\n❓ ${q}`);
  const res = await engine.ask(q);
  console.log(`💬 ${res.explanation || '(no explanation)'}`);
  console.log(`📝 db.${res.collection}.aggregate(${res.pipelineJson})`);
  const out = await engine.execute(res.pipelineJson, res.collection);
  console.log(`📊 ${out.columns.map((c) => c.name).join(' | ')}`);
  for (const row of out.rows.slice(0, 5)) console.log(`   ${row.map((v) => (v === null ? 'NULL' : v)).join(' | ')}`);
}

await connector.close();
console.log('\n✅ done');
