# @asksql/duckdb

## 0.2.3

### Patch Changes

- Document the DuckDB-WASM browser build's Web Worker + WebAssembly CSP requirements (and the self-hosted-bundle option) so the browser connector works under a strict Content-Security-Policy.
- Updated dependencies
  - @asksql/core@0.3.1

## 0.2.2

### Patch Changes

- Updated dependencies
  - @asksql/core@0.3.0

## 0.2.1

### Patch Changes

- f92c594: Expose the connected database name (the file, or in-memory) for display.
- Updated dependencies [f92c594]
  - @asksql/core@0.2.1

## 0.2.0

### Minor Changes

- Opt-in low-cardinality value sampling; DuckDB `.sql` dump upload; MySQL uri/DSN fixes; prompt-quality fix.

### Patch Changes

- Updated dependencies
  - @asksql/core@0.2.0

## 0.1.2

### Patch Changes

- Defense in depth: DuckDB extension autoinstall/autoload are disabled at connect. DuckDB has no read-only
  session, so a query reaching for a dangerous extension family (httpfs `http_*`, the postgres/mysql/sqlite
  scanners, spatial `st_read*`) now errors at the engine instead of loading it, even if the guard denylist
  misses a name. Built-in CSV/Parquet/JSON and the explicitly-loaded Excel reader are unaffected.

- Fix an install failure: the `@duckdb/node-api` peer range was `>=1.1`, but every published version is a
  prerelease (`1.x.x-r.N`), which a plain `>=` range does not match, so `npm install @asksql/duckdb
@duckdb/node-api` failed with ETARGET. The range is now `>=1.4.0-r.1`.
- Registered file paths reject URL schemes (a network read / SSRF) and glob metacharacters by default;
  set `allowRemote` / `allowGlob` on the source to opt in.

- Security: fix a read-only guard bypass via statement smuggling.

  The SQL stripper treated any `e`/`E` before a quote as a PostgreSQL `E'...'` prefix, including the trailing E of `LIKE`, `ILIKE` and `date`. Inside an E-string a backslash escapes a quote, so the stripper ran past the end of the literal and swallowed the `;` after it. PostgreSQL and DuckDB do not treat a backslash as an escape in a plain literal, so they ended the string there and read the rest as further statements.

  The two lexers disagreeing made `hasMultipleStatements` report one statement where the server saw four, so a query of this shape passed the guard:

  ```sql
  SELECT id FROM t WHERE name LIKE'x\'; COMMIT; DROP TABLE t; SELECT 1 WHERE false --'
  ```

  The smuggled `COMMIT` ended the read-only transaction and the `DROP` committed. Reproduced end to end against a live PostgreSQL and DuckDB.

  Fixed in layers, so no engine depends on the guard's lexer agreeing with its parser:

  - **core**: an E-string prefix now counts only when `E` starts a token.
  - **core**: `query_to_xml` and the rest of the `*_to_xml` family are denied. They take SQL as a string, which the AST walk cannot see into, so `query_to_xml('SELECT pg_sleep(60)', ...)` bypassed every other denied function.
  - **postgres**: queries run over the extended query protocol, which carries one statement per message, so the server rejects multi-statement text structurally.
  - **duckdb**: queries run as a prepared statement, which compiles exactly one statement. DuckDB needed this most - it executes multiple statements from one string and has no read-only session, so the guard was its only defence.
  - **sqlite**: the "no driver" error now names Node's built-in `node:sqlite` alongside `better-sqlite3`, instead of sending everyone to a native module they may not need.

  Anyone running AskSQL against PostgreSQL or DuckDB should upgrade. Packages with no code change are released together so their pinned `@asksql/core` dependency picks up the fix.

- Updated dependencies
  - @asksql/core@0.1.2
