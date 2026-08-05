# @asksql/sqlite

The SQLite connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): introspection (tables, views, keys,
indexes) and guarded read-only query execution. On Node 22.5 or newer no driver
install is needed - the built-in `node:sqlite` is used automatically. Install
`better-sqlite3` alongside it if you prefer that driver, or need an older Node.

Either way the connection is opened read-only and verified: AskSQL sets `query_only`
and reads it back, and refuses a database it cannot put into read-only mode.

```bash
npm i @asksql/core @asksql/sqlite
```

```ts
import { SqliteConnector } from '@asksql/sqlite';

const connector = new SqliteConnector({ id: 'main', name: 'Main DB', file: './app.db' });
```

Pass the connector to `createAskSql` from `@asksql/core`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
