# @asksql/postgres

The PostgreSQL connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): introspection (tables, views, keys,
enums, indexes) and guarded read-only query execution. The driver (pg) is a
peer dependency, so you install it yourself.

```bash
npm i @asksql/core @asksql/postgres pg
```

```ts
import { PostgresConnector } from '@asksql/postgres';

const connector = new PostgresConnector({ id: 'main', name: 'Main DB', connectionString: process.env.DATABASE_URL });
```

`date`, `time`, `timetz` and `timestamp` are read back as text, so no timezone is guessed. Those
parsers are set on the connector's own pool, so `pg`'s global type-parser registry is left alone
and the rest of your app keeps its own decoding. A table Postgres has never analyzed reports no
row estimate rather than zero, so the model is not told an empty table.

Pass the connector to `createAskSql` from `@asksql/core`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
