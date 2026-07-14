# @asksql/server

The AskSQL server sidecar. It holds database credentials, enforces the SQL
guard server side (the browser never gets a raw database connection), applies
your auth hook per request, and streams chat responses over SSE. An Express
adapter is included.

```bash
npm i @asksql/core @asksql/server
```

```ts
import { asksqlMiddleware } from '@asksql/server/express';

app.use('/asksql', asksqlMiddleware({
  connectors: [connector],
  engine: { model },
  auth: (req) => ({ userId: '...', allowedConnectionIds: ['main'] }),
}));
```

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
