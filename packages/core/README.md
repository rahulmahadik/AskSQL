# @asksql/core

The AskSQL engine: schema catalog, AST-based read-only SQL guard, the
natural-language-to-SQL pipeline, and the model provider resolver. No database
drivers and no UI; those live in the adapter packages.

```bash
npm i @asksql/core @asksql/postgres
```

## Ask a question end to end

```ts
import { createAskSql, resolveModel, AskSqlError } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';

const model = await resolveModel({
  provider: 'groq',                       // openai | anthropic | google | azure | groq | nvidia | ollama | openai-compatible
  model: 'llama-3.3-70b-versatile',
  apiKey: process.env.GROQ_API_KEY,
});

const engine = createAskSql({
  connectors: [new PostgresConnector({ id: 'main', name: 'Main', connectionString: process.env.DATABASE_URL })],
  model,
});

const answer = await engine.ask('How many customers signed up this month?');
console.log(answer.sql);            // review before running
const result = await answer.run();  // guarded, read-only execution
console.table(result.rows);
```

The model only ever receives your **schema and the question, never your data**. Every generated
statement passes a deterministic AST guard before it can run. Writes, DDL and stacked statements are
refused, and a row `LIMIT` is injected automatically.

## Errors

Failures throw an `AskSqlError` with a stable `code` and a safe, plain-language `userMessage`
(internal detail stays in `detail`, out of `toJSON()`):

```ts
try {
  await engine.ask('…');
} catch (err) {
  if (AskSqlError.is(err)) {
    // e.g. LLM_AUTH, LLM_UNREACHABLE, GUARD_BLOCKED, CONFIG_ERROR, DB_QUERY_ERROR
    console.error(err.code, err.userMessage);
  } else {
    throw err;
  }
}
```

## Model providers

`resolveModel(...)` returns a model the engine can use. Official API hosts are pre-seeded per provider,
so `baseURL` is only needed to override a default (an OpenAI-compatible gateway, or a non-local Ollama).
`PROVIDER_API_HOST` exposes the defaults.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
