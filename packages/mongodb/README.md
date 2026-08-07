# @asksql/mongodb

The MongoDB connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): sampling-based
schema inference across collections and guarded read-only aggregation pipelines. This is
the non-SQL path: the model emits a (collection, pipeline) pair, not SQL, and the engine
entry point differs (see below). The driver (mongodb) is a peer dependency, so you
install it yourself.

```bash
npm i @asksql/core @asksql/mongodb mongodb
```

Requires Node 20+ and mongodb 6.0 or newer.

```ts
import { MongodbConnector } from '@asksql/mongodb';

const connector = new MongodbConnector({
  id: 'main',
  name: 'Main DB',
  connectionString: process.env.MONGODB_URI!, // mongodb:// or mongodb+srv://
  database: 'app', // required: names the DB to introspect and query
});
```

Pass the connector to `createMongoAskSql` from `@asksql/core/mongo`, not to
`createAskSql`.

## Connecting

The connection string encodes the host set, replica set, TLS and auth: the same URI you
would give `mongosh` or Compass. You can also pass `user` and `password` separately;
the auth database then defaults to `admin` (where root and Atlas users live), override
with `authSource`.

```ts
connectionString: 'mongodb://localhost:27017'
connectionString: 'mongodb://user:password@localhost:27017'
connectionString: 'mongodb+srv://user:password@cluster0.abc12.mongodb.net'
```

The two most common Atlas failures:

- IP allow-list. Add your current IP under Atlas -> Network Access (or `0.0.0.0/0` to
  test). A blocked IP shows up as a TLS/connection error, not an auth error.
- The `<password>` placeholder. Atlas copies the URI with a literal `<password>`;
  replace it, drop the angle brackets, and URL-encode any `@ : / ?` in it.

## Read-only enforcement

MongoDB has no read-only session flag, so the core pipeline guard is the only safety
floor, and it is re-run on every execute. It is a fail-closed allowlist over the parsed
pipeline: write stages (`$out`, `$merge`) are simply absent from the allowlist, the
JS-execution operators (`$where`, `$function`, `$accumulator`) are refused at any
depth, regexes are bounded against ReDoS, and a trailing `$limit` is injected or
lowered to the row cap, including inside every `$facet` branch. The connector adds a
database-side `$limit` and `maxTimeMS` on top.

## Schema inference

MongoDB has no fixed schema, so `introspect()` samples up to 200 documents per
collection and infers each field's type and how often it is present. Example values
are gated twice: `sampleColumnValues` (opt-in) decides whether the connector collects
them, and the engine's `allowDataInPrompt` (default off) decides whether they reach a
prompt. With either off, the model sees field names, types and presence percentages
only.

## Values

Extended JSON in pipelines is deserialized in strict mode, and Long promotion is off,
so 64-bit integers and Decimal128 survive as strings instead of lossy JS numbers.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
