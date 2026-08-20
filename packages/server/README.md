# @asksql/server

The AskSQL server sidecar. It holds database credentials, enforces the SQL guard
server-side (the browser never gets a raw database connection), applies your auth
hook per request, and streams chat responses over SSE. An Express adapter is
included.

```bash
npm i @asksql/core @asksql/server @asksql/postgres pg express @ai-sdk/groq
```

`@asksql/core` is a peer dependency, and yarn (or npm with `legacy-peer-deps`) will not install it
for you, so name it explicitly as above.

## Run it as a server (no code)

```bash
npx --package=@asksql/server asksql serve --provider ollama --model qwen2.5-coder:7b
```

The bin is `asksql` but the package is `@asksql/server`, so `--package` is
required - a bare `npx asksql` resolves to a package that does not exist. If you
would rather have it installed once, `npm i -g @asksql/server` (plus your engines'
connector packages, e.g. `@asksql/postgres pg`) then just
`asksql serve …`.

Listens on `127.0.0.1:3000` and accepts database connections from the client at
runtime, so the AskSQL browser extension can offer an engine/host/port/user/password
form (PostgreSQL, MySQL, Oracle, MongoDB, SQLite, DuckDB). Point the extension at
`http://localhost:3000`.

Runtime connections are what make that form possible, so the server stays on loopback
unless you pass `--host` *and* `--allow-host <db-host>` naming which databases it may
open. On a loopback bind it also accepts SQLite/DuckDB file paths from the client and
requires a loopback `Host` header; bind anywhere else and both of those switch off, so a
client-supplied file path is refused. `asksql serve --help` lists every flag.

Opening a database needs that engine's connector next to the server - with npx,
chain packages (`npx --package=@asksql/server --package=@asksql/postgres --package=pg asksql serve ...`);
with a global install, `npm i -g @asksql/postgres pg` once. The OpenAI-compatible SDK
ships with the server, so `--provider ollama`, `nvidia` or `openai-compatible` (LM
Studio, gateways) needs nothing extra; `openai`, `anthropic`, `google`, `azure` and
`groq` need their own `@ai-sdk/*` package installed alongside, plus `--api-key`.

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
  model: 'openai/gpt-oss-20b', // an example: use whatever your provider lists at /models
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
| `maxBodyBytes` | no | Request body cap on the Express adapter. Default 64 KB. |
| `suggestFixOnError` | no | Offer a corrected query on a DB error. Default `true`. |
| `requireLoopbackHost` | no | Reject any request whose `Host` header is not loopback, with 403 `SERVER_AUTHZ`. Default off. `asksql serve` turns it on when it binds a loopback address. |
| `dynamicConnections` | no | Runtime connection management. Off unless `{ enabled: true }`; see below. |

`dynamicConnections` takes four fields:

| Field | Notes |
| --- | --- |
| `enabled` | Must be `true`, or `POST /connections` and `DELETE /connections/:id` return 404. |
| `allowedHosts` | Database hosts the server may open. Unset means any host, minus the link-local block below. Not consulted for file engines. |
| `allowFileEngines` | Allow client-supplied SQLite/DuckDB **file paths**. Unset means no. |
| `allowedFileRoots` | Directories a file path must resolve inside, symlinks resolved first. |

A client-supplied file path is refused (`INVALID_INPUT`, 400) unless you set `allowFileEngines:
true` **or** a non-empty `allowedFileRoots`. Setting only `allowFileEngines` allows any path the
server process can read, so pair it with `allowedFileRoots` unless the server is single-user on
loopback. `asksql serve` sets `allowFileEngines` only when it binds a loopback address.

With `suggestFixOnError` on, a SQL query that fails at the database gets a second model call for
a corrected query, returned as `suggestedSql` for the user to review and re-run; it never
auto-runs. The request must carry the original `question` - without the intent a repair is
guesswork - and the MongoDB path does not offer one. The driver's error text is redacted before
that call: row values are stripped out, the column, table and constraint names the model needs
are kept.

The wire response never includes internal error detail (hostnames, driver text); only a `code` and a
safe `userMessage`. Use `onError` if you need the full error server-side.

## HTTP endpoints

Every endpoint runs your auth hook first and checks the caller's connection scope.

- `POST /chat` - streams the answer as SSE: `stage`/`token` events, then a final `sql`
  event (with `explanation` and `autoLimited`), then `done`. For MongoDB the `sql` field
  carries the aggregation pipeline plus a `collection`.
- `POST /execute` - runs a statement through the server-side guard; accepts `maxRows`.
  On a database error the response can carry `suggestedSql` for the user to review.
- `POST /explain` - plain-language explanation of a statement (Mongo pipelines included).
- `POST /explainSchema` - schema questions in prose on any engine (MongoDB answers in
  collections and `$lookup`), including advisory add-a-column / index / performance
  suggestions as never-executed proposals. A question unrelated to data is declined.
- `GET /schema` - cached catalog; `refresh=1` re-introspects.
- `GET /history` - the caller's query history, paginated (`page`, `per_page`).
- `POST /feedback` - marks a question/SQL pair good; stored per user as a few-shot example
  when `engine.fewShots` is configured.
- `GET /health` - liveness plus the connections this caller may reach.
- `POST /connections` / `GET /connections` / `DELETE /connections/:id` - runtime
  connection management. `POST` and `DELETE` return 404 unless `dynamicConnections` is
  enabled; `GET` always lists the connections this caller may reach. Creating one needs the
  wildcard scope: `auth` must return `allowedConnectionIds: ['*']` (`ANY_CONNECTION`), the same
  authorization that lets a caller reach every connection. `DELETE` uses the ordinary per-id check.

A dropped client connection aborts the work behind it: the request's `AbortSignal` is passed to
`ask`, `execute`, `explain` and `explainSchema`, so Postgres and MySQL cancel the running query at
the database rather than leaving it to finish unread.

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
- Every request other than `GET`/`HEAD`/`OPTIONS` must be `application/json` (else 415). This is
  in the framework-agnostic handler, so every adapter gets it. The requirement forces a CORS
  preflight, so a cross-site "simple request" can never reach `/execute`. The Express adapter
  takes its own options as a second argument -
  `asksqlMiddleware(config, { cors: ['https://app.example.com'] })` - and keeps SSE alive behind
  proxies (heartbeats, anti-buffering headers).
- The content-type gate and the `requireLoopbackHost` check both run **before** your `auth` hook,
  so a rejected request never reaches it.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
