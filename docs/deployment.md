# Two ways to run

AskSQL runs either fully in the browser (files + DuckDB-WASM, no backend) or behind a
server sidecar that holds the database credentials. This page covers both, plus exactly
what to install for each mode.

## How it fits together

```text
  Browser                         Your server                    Your database
  ---------------------           ----------------------         -------------------
  <AskSqlChat/>                    @asksql/server                 Postgres / MySQL /
  <AskSqlBubble/>   --HTTP/SSE-->  - auth hook (your login)       SQLite / DuckDB /
  useAskSql  /  widget            - holds DB credentials          Oracle / MongoDB
                                   - server-side guard
                                        |
                                        v
                                   @asksql/core (engine)
                                    1. introspect schema
                                    2. schema + question -----> LLM provider
                                       (no DB rows sent)   <----  generated SQL
                                    3. AST guard: read-only SELECT only
                                       (blocked -> refused, never runs)
                                    4. connector runs it (read-only session
                                       where the engine supports it) --> DB
```

Credentials and the authoritative guard live on the server; the browser only ever sends a
question and renders results. The model sees your **schema and the question, never your rows**.

Client-only mode collapses this: `<AskSqlChat/>` talks straight to `@asksql/core` and a
DuckDB-WASM connector in the same tab, with no server and nothing leaving the browser.

## Client-only (zero backend)

Files + DuckDB in the browser, model called directly:

```ts
import { createAskSql, resolveModel } from '@asksql/core';
import { DuckDbWasmConnector } from '@asksql/duckdb/browser';

// `file` is a File from an <input type="file"> - the browser connector takes content, not a path.
const connector = new DuckDbWasmConnector({ id: 'files', name: 'Files',
  files: [{ table: 'sales', data: file, filename: file.name }] });
const model = await resolveModel({ provider: 'ollama', model: 'qwen2.5-coder:7b',
  baseURL: 'http://localhost:11434/v1' });
const engine = createAskSql({ connectors: [connector], model });

const answer = await engine.ask('Which region has the highest sales?');
console.log(answer.sql);            // reviewed before it runs
const result = await answer.run();  // guarded + executed
```

## Server sidecar

Credentials stay server-side, browser talks HTTP:

```ts
import express from 'express';
import { asksqlMiddleware } from '@asksql/server/express';
import { PostgresConnector } from '@asksql/postgres';
import { resolveModel } from '@asksql/core';

const app = express();
app.use(express.json());
app.use('/asksql', asksqlMiddleware({
  connectors: [new PostgresConnector({ id: 'shop', name: 'Shop', connectionString: process.env.DATABASE_URL })],
  engine: { model: await resolveModel({ provider: 'groq', model: 'openai/gpt-oss-20b', apiKey: process.env.GROQ_API_KEY }) },
  auth: (req) => ({ userId: lookUpSession(req), allowedConnectionIds: ['shop'] }), // your auth
}));
```

See the [`@asksql/server` README](../packages/server/README.md) for the auth hook,
endpoints, runtime connections, and the no-code `asksql serve` CLI.

## Install only what your mode needs

Every setup is **three parts**, and you install only the ones you use:

1. **Engine** - `@asksql/core` (always).
2. **Data layer** - a database adapter + its driver (`@asksql/postgres` + `pg`, `@asksql/mysql`
   + `mysql2`, `@asksql/sqlite` on its own from Node 22.5), **or** `@asksql/duckdb` +
   `@duckdb/duckdb-wasm` for browser file-analytics. Plus `@asksql/server` when you run the
   sidecar, and `@asksql/react` for the UI.
3. **Model-provider SDK** - one `@ai-sdk/*` package for the LLM you picked (see the table below).

Nothing outside those is pulled in - a MySQL-only app never downloads DuckDB's WASM or `pg`.

```bash
# Browser file analytics (CSV/JSON/Parquet, zero backend) with a local Ollama model:
npm i @asksql/core @asksql/react @asksql/duckdb @duckdb/duckdb-wasm @ai-sdk/openai-compatible

# Server sidecar over MySQL, using OpenAI:
npm i @asksql/core @asksql/server @asksql/react @asksql/mysql mysql2 @ai-sdk/openai

# Server sidecar over Postgres, using Groq:
npm i @asksql/core @asksql/server @asksql/react @asksql/postgres pg @ai-sdk/groq
```

Pick the **one** model-provider SDK that matches your `provider` - they are optional peer deps:

| `provider` | Install |
|------------|---------|
| `openai` | `@ai-sdk/openai` |
| `anthropic` | `@ai-sdk/anthropic` |
| `google` | `@ai-sdk/google` |
| `azure` (classic) | `@ai-sdk/azure` |
| `groq` | `@ai-sdk/groq` |
| `nvidia` | `@ai-sdk/openai-compatible` |
| `ollama`, `openai-compatible` (LM Studio, vLLM, OpenRouter, Azure AI Foundry, ...) | `@ai-sdk/openai-compatible` |

Per-provider configuration lives in [providers.md](providers.md).

## Examples

Each mode has a runnable example in [`examples/`](../examples):

- **`examples/browser-duckdb`** - no backend at all: upload a CSV, ask questions, everything
  runs in the tab via DuckDB-WASM. Nothing leaves the browser. ([screenshot](screenshots/README.md))
- `examples/node-duckdb` - headless file analytics with a real model.
- `examples/node-oracle` - headless Oracle (Thin-mode driver, EZConnect string).
- `examples/node-mongodb` - headless MongoDB (aggregation-pipeline engine, `mongodb://` URI).
- `examples/express-postgres` - sidecar + static page over live Postgres.
- `examples/vite-react` - the React app (bubble + full page).
- `examples/plain-html` - one `<script>` tag, `AskSQL.mount(...)`.

Runs on any OS (macOS/Linux/Windows) and any modern browser - the browser connector uses only
standard Web Worker / OPFS / File APIs.
