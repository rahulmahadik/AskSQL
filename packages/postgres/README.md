# @asksql/postgres

The postgres connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): introspection (tables, views, keys,
enums, indexes) and guarded read-only query execution. The driver (pg) is a
peer dependency, so you install it yourself.

```bash
npm i @asksql/core @asksql/postgres pg
```

```ts
import { PostgresConnector } from '@asksql/postgres';

const connector = new PostgresConnector({ id: 'main', name: 'Main DB', connectionString: process.env.DATABASE_URL });
```

Pass the connector to `createAskSql` from `@asksql/core`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
