# @asksql/server

The AskSQL server sidecar. It holds database credentials, enforces the SQL guard
server-side (the browser never gets a raw database connection), applies your auth
hook per request, and streams chat responses over SSE. An Express adapter is
included.

```bash
npm i @asksql/core @asksql/server @asksql/postgres pg express @ai-sdk/groq
```

## Run it as a server (no code)

```bash
npx --package=@asksql/server asksql serve --provider ollama --model qwen2.5-coder:14b
```

The bin is `asksql` but the package is `@asksql/server`, so `--package` is
required - a bare `npx asksql` resolves to a package that does not exist. If you
would rather have it installed once, `npm i -g @asksql/server` (plus your engines'
connector packages, e.g. `@asksql/postgres pg`) then just
`asksql serve …`.

Listens on `127.0.0.1:3000` and accepts database connections from the client at
runtime, so the AskSQL browser extension can offer an engine/host/port/user/password
form (PostgreSQL, MySQL, Oracle, MongoDB, SQLite, DuckDB). POST `/explainSchema` answers schema questions in prose (SQL engines), including
advisory add-a-column / index / performance suggestions as never-executed DDL
proposals. Point the extension at
`http://localhost:3000`.

Runtime connections are what make that form possible, so the server stays on loopback
unless you pass `--host` *and* `--allow-host <db-host>` naming which databases it may
open. `asksql serve --help` lists every flag.

Opening a database needs that engine's connector next to the server - with npx,
chain packages (`npx --package=@asksql/server --package=@asksql/postgres --package=pg asksql serve ...`);
with a global install, `npm i -g @asksql/postgres pg` once. The model side needs
nothing extra: the OpenAI-compatible SDK (Ollama, LM Studio, gateways) ships with
the server.

To embed the server instead, construct `AskSqlServer` yourself and pass
`dynamicConnections: { enabled: true }` only if you want that same behaviour.


## A complete Express sidecar

```ts
import express from 'express';
import { asksqlMiddleware } from '@asksql/server/express';
import { PostgresConnector } from '@asksql/postgres';
import { resolveModel } from '@asksql/core';

const app = express();

const connector = new PostgresConnector({
  id: 'main',
  name: 'Production (read-only)',
  connectionString: process.env.DATABASE_URL,
});

const model = await resolveModel({
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  apiKey: process.env.GROQ_API_KEY,
});

app.use('/asksql', asksqlMiddleware({
  connectors: [connector],
  engine: { model },
  // Required: resolve identity + which connections this caller may reach.
  // Derive it from YOUR session/JWT; never trust a client-supplied id.
  // `req.headers` keys are lowercased; there is no `req.header()` accessor.
  auth: (req) => ({ userId: req.headers['x-user'] ?? 'anon', allowedConnectionIds: ['main'] }),
  // Optional: observe every failure the server turns into a response.
  onError: (err, { method, path }) => console.error('asksql error', method, path, err),
}));

app.listen(3000);
```

Point [`@asksql/react`](https://www.npmjs.com/package/@asksql/react) or
[`@asksql/widget`](https://www.npmjs.com/package/@asksql/widget) at `/asksql` and you have a full
chat UI. Credentials and the model key stay on the server.

## Config

| Field | Required | Notes |
| --- | --- | --- |
| `connectors` | yes | The database connections the server may reach. |
| `engine` | yes | Shared engine settings, at least `{ model }`. |
| `auth` | yes | `(req) => { userId, allowedConnectionIds }`. No anonymous default. |
| `audit` | no | Sink called for every executed query. |
| `onError` | no | Best-effort hook for every error turned into a response (throwing from it is swallowed). |
| `maxBodyBytes` | no | Request body cap. Default 64 KB. |
| `suggestFixOnError` | no | Offer a corrected query on a DB error. Default `true`. |

The wire response never includes internal error detail (hostnames, driver text); only a `code` and a
safe `userMessage`. Use `onError` if you need the full error server-side.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)

## HTTP endpoints

Every endpoint runs your auth hook first and checks the caller's connection scope.

- `POST /chat` - streams the answer as SSE: `stage`/`token` events, then a final `sql`
  event (with `explanation` and `autoLimited`), then `done`. For MongoDB the `sql` field
  carries the aggregation pipeline plus a `collection`.
- `POST /execute` - runs a statement through the server-side guard; accepts `maxRows`.
  On a database error the response can carry `suggestedSql` for the user to review.
- `POST /explain` - plain-language explanation of a statement (Mongo pipelines included).
- `POST /explainSchema` - schema questions in prose, including advisory add-a-column /
  index / performance suggestions as never-executed DDL proposals (SQL engines).
- `GET /schema` - cached catalog; `refresh=1` re-introspects.
- `GET /history` - the caller's query history, paginated (`page`, `per_page`).
- `POST /feedback` - marks a question/SQL pair good; stored per user as a few-shot example.
- `GET /health` - liveness plus the connections this caller may reach.
- `POST /connections` / `GET /connections` / `DELETE /connections/:id` - runtime
  connection management (404 unless `dynamicConnections` is enabled).

## Safety notes

- Runtime connections refuse link-local hosts (cloud metadata) even when enabled;
  MongoDB URI hosts get the same allowlist checks, and credentials embedded in a
  Mongo URI are rejected - use the separate user/password fields.
- Postgres/MySQL runtime connections accept `ssl: 'disable' | 'trust' | 'verify'`.
- Return `allowedConnectionIds: ['*']` (exported as `ANY_CONNECTION`) to grant every
  connection - the right scope for a single-user sidecar, where runtime connections
  get server-generated ids no static list could name.
- Database drivers are optional peers loaded on first use - install only the engines
  you need (`@asksql/postgres`, `@asksql/mysql`, `@asksql/oracle`, `@asksql/mongodb`,
  `@asksql/sqlite`, `@asksql/duckdb`).
- On the Express adapter, POSTs must be `application/json` (else 415) - forcing a CORS preflight, so a
  cross-site "simple request" can never reach `/execute`. The Express adapter takes
  `{ cors: ['https://app.example.com'] }` and keeps SSE alive behind proxies
  (heartbeats, anti-buffering headers).

