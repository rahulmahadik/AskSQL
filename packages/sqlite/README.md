# @asksql/sqlite

The sqlite connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): introspection (tables, views, keys,
enums, indexes) and guarded read-only query execution. The driver (better-sqlite3) is a
peer dependency, so you install it yourself.

```bash
npm i @asksql/core @asksql/sqlite better-sqlite3
```

```ts
import { SqliteConnector } from '@asksql/sqlite';

const connector = new SqliteConnector({ id: 'main', name: 'Main DB', file: './app.db' });
```

Pass the connector to `createAskSql` from `@asksql/core`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
