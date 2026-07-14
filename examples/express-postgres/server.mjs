/**
 * Express + Postgres sidecar demo.
 *
 * Mounts the AskSQL sidecar at /asksql against a Postgres connection whose
 * credentials live ONLY here (never reach the browser). The bundled static
 * page (public/index.html) loads the widget and talks to this sidecar.
 *
 *   GROQ_API_KEY=... node examples/express-postgres/server.mjs
 */
import express from 'express';
import { asksqlMiddleware } from '@asksql/server/express';
import { PostgresConnector } from '@asksql/postgres';
import { resolveModel } from '@asksql/core';

const PG_URL = process.env.ASKSQL_PG_URL ?? 'postgres://postgres:root@localhost:5432/asksql_test';
const PORT = Number(process.env.PORT ?? 4000);

const model = process.env.GROQ_API_KEY
  ? await resolveModel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: process.env.GROQ_API_KEY })
  : await resolveModel({ provider: 'ollama', model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:14b', baseURL: 'http://localhost:11434/v1' });

const connector = new PostgresConnector({ id: 'shop', name: 'Shop DB', connectionString: PG_URL });

const app = express();
app.use(express.json());
app.use(express.static(new URL('./public', import.meta.url).pathname));

app.use(
  '/asksql',
  asksqlMiddleware({
    connectors: [connector],
    engine: { model, policy: { maxRows: 200 } },
    // Real apps resolve identity from a session/JWT here. Demo trusts everyone
    // and scopes them to the single 'shop' connection.
    auth: () => ({ userId: 'demo', allowedConnectionIds: ['shop'] }),
  }),
);

app.listen(PORT, () => {
  console.log(`AskSQL demo on http://localhost:${PORT}  (model: ${process.env.GROQ_API_KEY ? 'Groq' : 'Ollama'})`);
});
