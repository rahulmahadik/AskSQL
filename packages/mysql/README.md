# @asksql/mysql

The mysql connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): introspection (tables, views, keys,
enums, indexes) and guarded read-only query execution. The driver (mysql2) is a
peer dependency, so you install it yourself.

```bash
npm i @asksql/core @asksql/mysql mysql2
```

```ts
import { MysqlConnector } from '@asksql/mysql';

const connector = new MysqlConnector({
  id: 'main', name: 'Main DB',
  uri: process.env.DATABASE_URL, database: 'shop',
});
```

Pass the connector to `createAskSql` from `@asksql/core`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
