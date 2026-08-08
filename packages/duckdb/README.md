# @asksql/duckdb

The DuckDB connector for [AskSQL](https://github.com/rahulmahadik/AskSQL): local analytics over
CSV / JSON / NDJSON / Parquet / Excel files, a portable `.sql` dump (CREATE TABLE + INSERT), or a
DuckDB database file, with no backend. Two entry points share one implementation:

- `@asksql/duckdb` (Node), on `@duckdb/node-api`.
- `@asksql/duckdb/browser`, on `@duckdb/duckdb-wasm`, in a Web Worker with optional
  OPFS persistence. Data never leaves the tab.

Both drivers are optional peer dependencies; install the one you use.

```bash
npm i @asksql/core @asksql/duckdb @duckdb/node-api     # Node
npm i @asksql/core @asksql/duckdb @duckdb/duckdb-wasm  # browser
```

`@asksql/core` is a peer dependency, and yarn (or npm with `legacy-peer-deps`) will not install it
for you, so name it explicitly as above.

## Node

```ts
import { DuckDbConnector } from '@asksql/duckdb';

const connector = new DuckDbConnector({
  id: 'files', name: 'Files',
  files: [{ table: 'sales', path: 'sales.csv', format: 'csv' }],
});
// pass to createAskSql({ connectors: [connector], model })
```

## Read-only enforcement

Read-only here is conditional, and worth understanding:

- A `path` with no `files` opens the database with `access_mode=READ_ONLY`. The mode is
  read back before the handle is used, and a handle that does not report `read_only` is
  refused. A missing file is not created.
- Registering `files` writes views into the database, so that configuration (and
  `:memory:`, the default) is read-write. The core AST guard is then the only barrier:
  single SELECT, denylisted functions, row cap. DuckDB's network and foreign-database
  functions (`http_get`, `postgres_query`, `duckdb_secrets`, anything ending `_query`,
  `_scan`, `_attach` or `_execute`) are denied outright. Its file readers (`read_csv`,
  `read_parquet`, the `read_`/`scan_` families) are denied unless the guard policy opts
  into `allowFileFunctions`.
- Extension autoloading (`autoinstall_known_extensions`, `autoload_known_extensions`)
  is switched off on connect, so httpfs and the external-database scanners cannot load
  implicitly. Only the excel extension is loaded, explicitly, when an .xlsx file is
  registered.
- The browser build is always read-write; the guard applies there identically.

Queries run one at a time on the shared connection; a timeout interrupts the running
query rather than wedging the connection.

## Browser (DuckDB-WASM)

Register uploaded content directly: pass the `File`/`Blob` (or an `ArrayBuffer`/text) as
`data`, not a path. Files are read and queried entirely inside the tab.

```ts
import { DuckDbWasmConnector } from '@asksql/duckdb/browser';

// `file` is a File from an <input type="file"> or a drag-and-drop.
const connector = new DuckDbWasmConnector({
  id: 'files', name: 'Files',
  files: [{ table: 'sales', data: file, filename: file.name }], // format inferred from filename
});
// pass to createAskSql({ connectors: [connector], model }); connect() runs lazily
```

### WASM + CSP notes

DuckDB-WASM runs in a Web Worker and instantiates WebAssembly, so the page's
Content-Security-Policy must allow both. A working policy:

```
script-src 'self' 'wasm-unsafe-eval' blob:;
worker-src 'self' blob:;
connect-src 'self' https://cdn.jsdelivr.net;
```

- `wasm-unsafe-eval` compiles the `.wasm` module (plain `'unsafe-eval'` also works but
  is broader). Without it the worker fails to start and the connector reports a
  `WASM_LOAD` error.
- `blob:` covers the worker the bundle spins up.
- By default the WASM bundles load from the jsDelivr CDN (hence the `connect-src`).
  For offline or strict-CSP deployments, self-host the bundles and pass their URLs via
  the `bundles` option, then drop the CDN from `connect-src`.
- Cross-origin isolation (COOP/COEP) is not required for the default single-threaded
  build.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
