# @asksql/core

## 0.3.3

### Patch Changes

- Render fenced ` ```sql ` code blocks in explanations and schema answers as real code blocks instead of literal backticks, and stop capping the query description at a fixed length so it always renders complete.

## 0.3.2

### Patch Changes

- 4294cdc: Security and reliability hardening. Broaden the DuckDB `.sql` upload denylist to the full reader/scan family (blocks `read_csv_auto`, `read_blob`, `parquet_scan`, and quoted-path reads); bound the Mongo regex and aggregation guards (all regex carriers, unbounded `$push`/`$group`, 64-bit literals); clamp `maxRows` on fetch-style dialects (Oracle) and read duplicate-named DuckDB columns positionally; fix a Postgres connection-pool deadlock and scope few-shot/history stores per user; correct the guard's OFFSET-as-LIMIT handling; and answer broad schema and relationship questions from the full catalog, including foreign keys inferred from naming when none are declared.

## 0.3.1

### Patch Changes

- Fail fast on misconfiguration instead of much later with a confusing error: reject a connector with an empty id or name, reject a PostgreSQL connector that has neither a connection string nor a host, and report a missing SQLite database file separately from a missing driver (previously both cases said "install better-sqlite3").

## 0.3.0

### Minor Changes

- Add NVIDIA as a first-class provider and pre-seed the official API host for every provider (OpenAI, Anthropic, Google, Groq, NVIDIA, Ollama) via the exported `PROVIDER_API_HOST` registry, so a `baseURL` is only needed to override a default. Classify a wrong or unavailable model id (HTTP 404 / "model not found") as a configuration error with an actionable message instead of a transient "try again". Keep the auto-`LIMIT` bound to the final SELECT when a statement ends with a semicolon followed by a comment — previously the row cap could be severed off, leaving an unbounded scan.

## 0.2.1

### Patch Changes

- f92c594: Scope query history per user in server mode: `HistoryEntry`, `AskOptions`, and the engine's execute path gain an optional `userId`, and `HistoryStore.list` filters by it, so one caller can no longer read another's questions and SQL. Surface a failed schema introspection instead of caching it — an empty table set accompanied by warnings now raises rather than looking like an empty database, and a partially-warned catalog uses a short cache TTL so transient faults self-heal. Block unbounded recursive CTEs on SQLite (a `WITH RECURSIVE` consumed by an aggregate, `GROUP BY`, or `DISTINCT` with no `LIMIT`) before they can hang a synchronous query. Add an optional `database` display name to the `Connector` contract.

## 0.2.0

### Minor Changes

- Opt-in low-cardinality value sampling; DuckDB `.sql` dump upload; MySQL uri/DSN fixes; prompt-quality fix.

## 0.1.2

### Patch Changes

- Security (audit): closed a class of read-only guard bypasses found in a multi-round adversarial audit. The guard now rejects MySQL executable comments (`/*! ... */`, which the server runs but the comment stripper skipped), DuckDB foreign-database / scanner / file-reader / network functions (with engine-level extension autoload disabled behind them), PostgreSQL write, side-effect, replication, large-object and filesystem functions, and row-locking (`FOR UPDATE`, `LOCK IN SHARE MODE`). Whole families are closed structurally with prefix / suffix rules, so future members are covered without enumeration, and the denied set is pinned by the guard's regression suite. Provider baseURL validation was also hardened: it rejects link-local / cloud-metadata hosts, refuses to send an API key over plaintext http to a remote host, and no longer interpolates the raw URL into error details; `google` / `groq` honor a user-supplied baseURL; and the `@ai-sdk/openai-compatible` peer range is corrected to `^3`.

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

- Accuracy: the column-level hallucination check now attributes an unqualified column to its table using the schema catalog, so a query selecting a column that no in-scope table actually has (a model hallucination) is caught before it runs, in single-table and fully-known join queries alike. Queries over unknown tables or subqueries still pass through unchanged. Previously any unqualified unknown column slipped past this check.
