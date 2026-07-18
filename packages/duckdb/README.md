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

## Node

```ts
import { DuckDbConnector } from '@asksql/duckdb';

const connector = new DuckDbConnector({
  id: 'files', name: 'Files',
  files: [{ table: 'sales', path: 'sales.csv', format: 'csv' }],
});
// pass to createAskSql({ connectors: [connector], model })
```

## Browser (DuckDB-WASM)

Register uploaded content directly — pass the `File`/`Blob` (or an `ArrayBuffer`/text) as `data`, not a
path. Nothing is uploaded; files are read and queried entirely inside the tab.

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

DuckDB-WASM runs in a **Web Worker** and instantiates WebAssembly, so the page's Content-Security-Policy
must allow both. A working policy:

```
script-src 'self' 'wasm-unsafe-eval' blob:;
worker-src 'self' blob:;
connect-src 'self' https://cdn.jsdelivr.net;
```

- `wasm-unsafe-eval` is required to compile the `.wasm` module (plain `'unsafe-eval'` also works but is
  broader). Without it the worker fails to start and the connector reports a `WASM_LOAD` error.
- `blob:` covers the worker the bundle spins up.
- By default the WASM bundles load from the **jsDelivr CDN** (hence `connect-src https://cdn.jsdelivr.net`).
  For offline or strict-CSP deployments, self-host the bundles and pass their URLs via the `bundles`
  option, then drop the CDN from `connect-src`.
- Cross-origin isolation (COOP/COEP) is **not** required for the default single-threaded build.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
