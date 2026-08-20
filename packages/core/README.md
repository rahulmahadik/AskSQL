# @asksql/core

The AskSQL engine: schema catalog, AST-based read-only SQL guard, the
natural-language-to-SQL pipeline, and the model provider resolver. No database
drivers and no UI; those live in the adapter packages.

```bash
npm i @asksql/core @asksql/postgres pg @ai-sdk/groq
```

## Ask about the schema itself, not just the data

`explainSchema(question)` answers schema questions in plain language, grounded in
the real catalog: what tables exist, how they relate, and advisory suggestions -
add a column, create an index, improve performance - returned as DDL **proposals
it never executes**. Off-topic questions are declined rather than answered from
general knowledge. Answers are checked against the catalog; invented table or
column names are rejected and retried.
## Ask a question end to end

```ts
import { createAskSql, resolveModel, AskSqlError } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';

const model = await resolveModel({
  provider: 'groq',                       // openai | anthropic | google | azure | groq | nvidia | ollama | openai-compatible
  model: 'openai/gpt-oss-20b', // an example: use whatever your provider lists at /models
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

By default the model receives only your **schema and the question, never your data**. Every generated
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

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)

## MongoDB and custom models

MongoDB is non-SQL: import `createMongoAskSql` from `@asksql/core/mongo` with the
`@asksql/mongodb` connector - the same ask/guard/run flow, answering with a guarded
aggregation pipeline instead of SQL.

`model` also accepts a plain async function
(`({ system, prompt, signal }) => string | AsyncIterable<string>`) - an escape hatch
for custom gateways with no AI SDK involved.

## What else the engine does

Beyond ask -> approve -> run, all optional:

- **Explain a query in plain language** - `engine.explain(sql)` describes what a statement
  does, grounded in the schema.
- **Streaming progress** - `config.onEvent` (and per-ask `onEvent`) emits stage + token events
  across the pipeline (`catalog`, `prune`, `prompt`, `llm`, `extract`, `guard`, `repair`, `execute`,
  `done`) for live UIs.
- **Cancellation** - pass an `AbortSignal` to any ask/run/explain and Postgres/MySQL cancel the
  running query at the database.
- **Hallucination floor** - before a query runs, the engine deterministically checks every
  referenced table *and* column against your schema; if the model invents or mis-guesses a
  column (a common small-model slip), it is handed the real column list and re-asked, so the
  fix happens before the database ever sees the query. The schema is also auto-shrunk and
  retried once on context overflow.
- **Identifier quoting** - names a database would not read back as themselves are quoted from the
  catalog before the query is validated, following each engine's own rule: Postgres folds unquoted
  names down, Oracle folds them up, MySQL on Linux compares table names case-sensitively, and every
  engine has reserved words. A mixed-case schema therefore works without the model having to
  remember quotes, and names that are already correct are left alone. If a database still rejects a
  name, the corrected query comes from the catalog rather than a second model call.
- **Semantic floors** - a query that would be rejected or would answer the wrong question is
  repaired before it runs: an aggregate beside a bare column with no `GROUP BY`, an aggregate nested
  inside another (`AVG(SUM(x))`), and a one-to-many join that inflates a `SUM`.
- **Follow-up context** - prior turns are threaded into the prompt so "now break that down by
  month" works.
- **Query history** - `config.history` records every attempt (status, duration), backed by an
  in-memory store.
- **Schema pruning + token budget** - large catalogs are pruned to the most relevant tables
  under a token budget (`config.pruner`) before prompting.
- **Privacy by default** - only the schema is ever sent. `allowDataInPrompt` (default off) is the
  opt-in for cell values, and it now gates three channels, not one: sampled column values, stripped
  from the catalog so a connector that samples cannot leak them into any prompt (the first prompt, a
  repair, `explain`, or `explainSchema`); the key NAMES inside a JSON column, where the default states
  how many recur but not which, because a map with a stable key set is structurally identical to a
  record; and the distinct values named in a coded-column repair, where the default attaches a caveat
  for the reader instead. The MongoDB engine takes the same option for the values its document
  sampling infers. Declared enum labels come from the schema and are kept either way. Query results
  are never sent on any path.

Prompts, model sampling, guard policy, and grounding (glossary, few-shots) are configurable
without forking; see
[docs/configuration.md](https://github.com/rahulmahadik/AskSQL/blob/HEAD/docs/configuration.md).
