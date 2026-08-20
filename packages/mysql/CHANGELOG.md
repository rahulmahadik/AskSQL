# @asksql/mysql

## 0.4.0

### Minor Changes

- Describe what a column's type leaves out, and fix a set of AI provider issues.

  The schema now states two things a column type cannot: the unit of an integer timestamp, and the shape
  of a JSON column. Comparing epoch milliseconds against epoch seconds matches every row and raises no
  error, and a guessed JSON key matches none, so both produced confident wrong answers. Every engine emits
  the hint in its own syntax, from one shared implementation.

  Also fixed: model listing now reports the provider's own error instead of returning an empty list;
  models that cannot answer a question are no longer offered; a hosted provider configured with a local
  base URL is refused rather than sent the API key; and reasoning-model output no longer appears in
  answers, explanations, or the token stream.

## 0.3.1

### Patch Changes

- Republished against the engine fix for a date comparison that answered zero, or the whole table,
  without raising an error.

  The widget bundles the engine, so a fix reaches its users only when it is published. The others take
  the engine as a peer dependency and pick it up on install; they move here so that every published
  package in a release is built against the same engine.

## 0.3.0

### Minor Changes

- 3e7cb1b: Depend on `@asksql/core` as a peer rather than a regular dependency. As a regular dependency, a
  consumer pinned to a different core minor got a second copy of core installed under the connector
  instead of a resolution error. Structural types survive that; identity does not, so
  `error instanceof AskSqlError` was false for every error the connector threw and consumer error
  handling silently stopped matching. The peer range is `>=0.6.0`, so npm and pnpm install one shared
  core and report a real conflict when the consumer's pin cannot satisfy it.

  Yarn (classic and berry) and npm with `legacy-peer-deps` do not install peers, so on those
  `@asksql/core` must now be installed explicitly alongside the package.

## 0.2.6

### Patch Changes

- abd7a9e: Report what actually failed when a connection is refused: a wrong password or a
  database that does not exist is no longer reported as an unreachable server, which
  sent users to check a host and port that were fine.

  Return every value as the database stored it: exact numerics keep their type and
  precision, NaN and Infinity survive, bigints nested in objects are not coerced, and
  leading, trailing or whitespace-only strings arrive with their spaces intact.

  A connection whose query timed out is dropped rather than rolled back and returned
  to the pool, where it could hand the next caller a statement still running.

- Updated dependencies [abd7a9e]
  - @asksql/core@0.6.0

## 0.2.5

### Patch Changes

- 1c52198: Stop a query timeout leaking onto the next query a pooled connection serves.

  The execution cap was applied with `SET SESSION MAX_EXECUTION_TIME`, which outlives `release()`
  and so capped whatever query the pooled connection served next, at whichever limit the previous
  caller happened to ask for. It is now a statement-scoped hint on the query itself. The client-side
  deadline is unchanged and still the real guarantee for a server that ignores the hint.

- Updated dependencies [1c52198]
- Updated dependencies [1c52198]
- Updated dependencies [1c52198]
  - @asksql/core@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [3c4c92b]
  - @asksql/core@0.4.0

## 0.2.3

### Patch Changes

- Internal refactors and minor fixes: the MySQL connector's schema introspection and value shaping now live in dedicated modules, consistent with the other connectors; plus small SQLite, widget, and MCP cleanups.
- Updated dependencies [4294cdc]
  - @asksql/core@0.3.2

## 0.2.2

### Patch Changes

- Updated dependencies
  - @asksql/core@0.3.0

## 0.2.1

### Patch Changes

- f92c594: Enforce a real query deadline that also works on MariaDB: set both `MAX_EXECUTION_TIME` and `max_statement_time`, plus a client-side deadline that `KILL`s the backend when a query overruns. Keep duplicate result-column names distinct by reading rows positionally. Expose the connected database name for display.
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

- Fix query cancellation: the backend id query was invalid SQL (`CONNECTION_ID` -> `CONNECTION_ID()`), so `KILL QUERY` never fired.

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
