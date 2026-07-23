# @asksql/postgres

## 0.2.4

### Patch Changes

- 4294cdc: Security and reliability hardening. Broaden the DuckDB `.sql` upload denylist to the full reader/scan family (blocks `read_csv_auto`, `read_blob`, `parquet_scan`, and quoted-path reads); bound the Mongo regex and aggregation guards (all regex carriers, unbounded `$push`/`$group`, 64-bit literals); clamp `maxRows` on fetch-style dialects (Oracle) and read duplicate-named DuckDB columns positionally; fix a Postgres connection-pool deadlock and scope few-shot/history stores per user; correct the guard's OFFSET-as-LIMIT handling; and answer broad schema and relationship questions from the full catalog, including foreign keys inferred from naming when none are declared.
- Updated dependencies [4294cdc]
  - @asksql/core@0.3.2

## 0.2.3

### Patch Changes

- Fail fast on misconfiguration instead of much later with a confusing error: reject a connector with an empty id or name, reject a PostgreSQL connector that has neither a connection string nor a host, and report a missing SQLite database file separately from a missing driver (previously both cases said "install better-sqlite3").
- Updated dependencies
  - @asksql/core@0.3.1

## 0.2.2

### Patch Changes

- Updated dependencies
  - @asksql/core@0.3.0

## 0.2.1

### Patch Changes

- f92c594: Bound opt-in value sampling with a `SET LOCAL statement_timeout` on a dedicated client, so an unindexed column can no longer full-scan during introspection. Expose the connected database name for display.
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

- Set a 15s connect timeout (pg's default is 0, i.e. wait forever), so an unreachable host fails instead of hanging.

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
