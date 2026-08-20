# @asksql/oracle

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

- Read the schema an account was granted, not just its own.

  Introspection scopes to the session's `CURRENT_SCHEMA`, which is empty for an account that holds
  grants on another owner's tables: the catalog came back with nothing and every question failed
  against an apparently empty database. A new `schema` config option names the owner to read, and the
  session is put in that schema so an unqualified name resolves where the catalog says it is. The name
  is checked against Oracle's identifier rules before use, since it cannot be bound as a parameter.

  When the scope really is empty, the warning now names the schemas the account can read instead of
  reporting a database with no tables.

## 0.2.0

### Minor Changes

- 3e7cb1b: Depend on `@asksql/core` as a peer rather than a regular dependency. As a regular dependency, a
  consumer pinned to a different core minor got a second copy of core installed under the connector
  instead of a resolution error. Structural types survive that; identity does not, so
  `error instanceof AskSqlError` was false for every error the connector threw and consumer error
  handling silently stopped matching. The peer range is `>=0.6.0`, so npm and pnpm install one shared
  core and report a real conflict when the consumer's pin cannot satisfy it.

  Yarn (classic and berry) and npm with `legacy-peer-deps` do not install peers, so on those
  `@asksql/core` must now be installed explicitly alongside the package.

## 0.1.4

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

## 0.1.3

### Patch Changes

- 1c52198: Tighten the connector internals and the documentation that ships with them.

  No API changed. The comments carried through each package were rewritten to state what the code
  does rather than narrate how it came to be written, which is what shows up in editor tooltips and
  generated docs. Alongside that, the BSON value handling shared by MongoDB introspection and result
  shaping is documented against the types it actually produces, and the row-shaping paths agree with
  the guard about which trailing limit is the truncation signal, so a result that exactly fills the
  row cap is no longer probed a second time.

- Updated dependencies [1c52198]
- Updated dependencies [1c52198]
- Updated dependencies [1c52198]
  - @asksql/core@0.5.0

## 0.1.2

### Patch Changes

- Updated dependencies [3c4c92b]
  - @asksql/core@0.4.0

## 0.1.1

### Patch Changes

- 4294cdc: Security and reliability hardening. Broaden the DuckDB `.sql` upload denylist to the full reader/scan family (blocks `read_csv_auto`, `read_blob`, `parquet_scan`, and quoted-path reads); bound the Mongo regex and aggregation guards (all regex carriers, unbounded `$push`/`$group`, 64-bit literals); clamp `maxRows` on fetch-style dialects (Oracle) and read duplicate-named DuckDB columns positionally; fix a Postgres connection-pool deadlock and scope few-shot/history stores per user; correct the guard's OFFSET-as-LIMIT handling; and answer broad schema and relationship questions from the full catalog, including foreign keys inferred from naming when none are declared.
- Updated dependencies [4294cdc]
  - @asksql/core@0.3.2

## 0.1.0

### Minor Changes

- Initial release: Oracle Database connector for AskSQL. Data-dictionary introspection (tables, views, columns, primary keys, foreign keys, table/column comments, row estimates) scoped to the current schema, and read-only query execution enforced with a per-query `SET TRANSACTION READ ONLY`. Uses the `oracledb` driver in pure-JS Thin mode (no Instant Client). Row cap enforced at the driver plus a hard slice; numeric fidelity preserved by fetching `NUMBER` as strings, `CLOB` as strings, and `BLOB` as buffers.
