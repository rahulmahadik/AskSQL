# @asksql/oracle

The Oracle Database connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): data-dictionary
introspection (tables, views, columns, primary keys, foreign keys, comments) and guarded read-only
query execution. The driver (oracledb) is a peer dependency, so you install it yourself. It runs in
pure-JS **Thin mode** — no Oracle Instant Client required.

```bash
npm i @asksql/core @asksql/oracle oracledb
```

```ts
import { OracleConnector } from '@asksql/oracle';

// Discrete fields (host:port/service):
const connector = new OracleConnector({
  id: 'main',
  name: 'Main DB',
  host: 'db.example.com',
  port: 1521,
  database: 'ORCLPDB1', // service name
  user: 'app',
  password: process.env.ORACLE_PASSWORD,
});

// Or an Easy Connect / TNS connect string:
// new OracleConnector({ id: 'main', name: 'Main DB', connectString: 'db.example.com:1521/ORCLPDB1', user: 'app', password: '...' });
```

Pass the connector to `createAskSql` from `@asksql/core`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
