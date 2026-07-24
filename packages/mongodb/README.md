# @asksql/mongodb

The MongoDB connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): sampling-based
schema inference across collections and guarded read-only aggregation pipelines.
The driver (mongodb) is a peer dependency, so you install it yourself.

```bash
npm i @asksql/core @asksql/mongodb mongodb
```

```ts
import { MongodbConnector } from '@asksql/mongodb';

const connector = new MongodbConnector({
  id: 'main',
  name: 'Main DB',
  connectionString: process.env.MONGODB_URI!, // mongodb:// or mongodb+srv://
  database: 'app',
});
```

## Connecting

MongoDB is configured by connection string (which encodes the host set, replica set, TLS and
auth), so it's the primary field - the same URI you'd give `mongosh` or Compass.

```ts
// Local
connectionString: 'mongodb://localhost:27017'

// Local with auth
connectionString: 'mongodb://user:password@localhost:27017'

// Remote / Atlas (SRV)
connectionString: 'mongodb+srv://user:password@cluster0.abc12.mongodb.net'
```

You can also pass `user` and `password` separately instead of embedding them in the URI:

```ts
new MongodbConnector({ id, name, database: 'app',
  connectionString: 'mongodb+srv://cluster0.abc12.mongodb.net', user: 'reader', password: process.env.MONGO_PW! });
```

**Atlas gotchas** (the two most common connection failures):

- **IP allow-list** — add your current IP under Atlas → **Network Access** (or `0.0.0.0/0` to test).
  A blocked IP shows up as a TLS/connection error, not an auth error.
- **The `<password>` placeholder** — Atlas copies the URI with a literal `<password>`; replace it
  with the real password (no angle brackets), and URL-encode any `@ : / ?` in it.

Because MongoDB has no fixed schema, `introspect()` samples up to 200 documents
per collection and infers each field's type, how often it is present, and (opt-in
via `sampleColumnValues`) a small set of example values. Queries are single
read-only aggregation pipelines; there is no read-only session, so the core
pipeline guard is the safety floor.

Pass the connector to `createMongoAskSql` from `@asksql/core/mongo`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
