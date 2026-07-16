# @asksql/duckdb

The DuckDB connector for [AskSQL](https://github.com/rahulmahadik/AskSQL), with two entry points:

- `@asksql/duckdb` (Node): query local CSV / JSON / Parquet / Excel files, load a
  portable `.sql` dump (CREATE TABLE + INSERT), or open a DuckDB database through
  `@duckdb/node-api`.
- `@asksql/duckdb/browser`: the same file analytics fully in the browser via
  DuckDB-WASM, with a Web Worker and optional OPFS persistence. Data never
  leaves the tab.

```bash
npm i @asksql/core @asksql/duckdb @duckdb/node-api     # Node
npm i @asksql/core @asksql/duckdb @duckdb/duckdb-wasm  # browser
```

```ts
import { DuckDbConnector } from '@asksql/duckdb';

const connector = new DuckDbConnector({
  id: 'files', name: 'Files',
  files: [{ table: 'sales', path: 'sales.csv', format: 'csv' }],
});
```

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
