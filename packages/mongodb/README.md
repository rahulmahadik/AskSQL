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

Because MongoDB has no fixed schema, `introspect()` samples up to 200 documents
per collection and infers each field's type, how often it is present, and (opt-in
via `sampleColumnValues`) a small set of example values. Queries are single
read-only aggregation pipelines; there is no read-only session, so the core
pipeline guard is the safety floor.

Pass the connector to `createMongoAskSql` from `@asksql/core/mongo`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
