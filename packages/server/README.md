# @asksql/server

The AskSQL server sidecar. It holds database credentials, enforces the SQL guard
server-side (the browser never gets a raw database connection), applies your auth
hook per request, and streams chat responses over SSE. An Express adapter is
included.

```bash
npm i @asksql/core @asksql/server @asksql/postgres
```

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
