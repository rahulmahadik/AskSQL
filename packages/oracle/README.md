# @asksql/oracle

The Oracle Database connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): data-dictionary
introspection (tables, views, columns, primary keys, foreign keys, comments) and guarded read-only
query execution. The driver (oracledb) is a peer dependency, so you install it yourself. It runs in
pure-JS Thin mode: no Oracle Instant Client, no native libraries.

```bash
npm i @asksql/core @asksql/oracle oracledb
```

`@asksql/core` is a peer dependency, and yarn (or npm with `legacy-peer-deps`) will not install it
for you, so name it explicitly as above.

Requires Node 20+ and oracledb 6.0 or newer.

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

## Read-only enforcement

Every statement passes the core AST guard first: a single SELECT, denylisted functions
refused. The connector then opens `SET TRANSACTION READ ONLY` before each query, with
autoCommit off, so the server rejects any write that slips through (ORA-01456 and
friends surface as a guard error, not a plain query failure). An Oracle read-only
transaction covers only itself, so one is opened per query and committed after it.

## Row caps

Oracle has no LIMIT clause, and the guard cannot inject its `FETCH FIRST` equivalent,
so the cap moves to the driver: at most maxRows + 1 rows are fetched, then hard-sliced,
with the extra row detecting truncation. A `FETCH FIRST`/`FETCH NEXT ... ROWS ONLY`
the model wrote anyway is lowered in place by the guard rather than wrapped in an
inline view, which would break duplicate output column names.

## Caveats

- Timeouts use the driver's `callTimeout` (ORA-01013 maps to a timeout error). There
  is no EXPLAIN, and cancel is not an advertised capability.
- NUMBER and CLOB are fetched as strings, BLOB as a Buffer. The fetch coercion is
  scoped per call, so the process-global oracledb defaults are left alone.
- Introspection is bounded too: `introspectTimeoutMs`, default 60s.
- Introspection reads the session's `CURRENT_SCHEMA`. An account that only holds grants on
  another owner's tables sees nothing there, so set `schema` to that owner; the session is
  put in it, and unqualified names then resolve where the catalog says they are.
- `sampleColumnValues` is accepted for config parity but not implemented for Oracle.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
