# @asksql/mysql

The MySQL connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): information_schema
introspection (tables, views, keys, enums, indexes) and guarded read-only query execution.
The driver (mysql2) is a peer dependency, so you install it yourself. MariaDB is served by
the same driver here; only the JetBrains plugin ships the MariaDB JDBC client instead.

```bash
npm i @asksql/core @asksql/mysql mysql2
```

Requires Node 20+ and mysql2 3.6 or newer.

```ts
import { MysqlConnector } from '@asksql/mysql';

const connector = new MysqlConnector({
  id: 'main',
  name: 'Main DB',
  host: 'localhost',
  port: 3306,
  user: 'reader',
  password: process.env.MYSQL_PASSWORD,
  database: 'shop',
});

// Or by connection string. The URI selects the database; pass '' explicitly.
// new MysqlConnector({ id: 'main', name: 'Main DB', uri: process.env.DATABASE_URL, database: '' });
```

Pass the connector to `createAskSql` from `@asksql/core`.

## Read-only enforcement

Every statement passes the core AST guard first: a single SELECT, denylisted functions
refused, a row cap injected or lowered. The connector then runs it inside
`START TRANSACTION READ ONLY` on a pooled connection, so the server itself rejects any
write that slips through. That rejection surfaces as a guard error, not a plain query
failure, and the transaction is committed or rolled back before the connection is
released.

## Timeouts and cancellation

The query timeout is attached as a `MAX_EXECUTION_TIME(ms)` optimizer hint on the
statement itself, so it never outlives the query or changes the pooled session other
statements reuse. The hint binds only to a leading SELECT. Anything it cannot reach, or
a server that ignores it, is stopped by a client-side deadline that issues `KILL QUERY`
against the backend. Aborting via `AbortSignal` kills the same way, from a side
connection.

## Values

`dateStrings` is on, so DATE/DATETIME/TIMESTAMP come back as text and no timezone is
guessed. DECIMAL and 64-bit integers come back as strings rather than lossy JS numbers.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
