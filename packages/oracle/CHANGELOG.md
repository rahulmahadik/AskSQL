# @asksql/oracle

## 0.1.1

### Patch Changes

- 4294cdc: Security and reliability hardening. Broaden the DuckDB `.sql` upload denylist to the full reader/scan family (blocks `read_csv_auto`, `read_blob`, `parquet_scan`, and quoted-path reads); bound the Mongo regex and aggregation guards (all regex carriers, unbounded `$push`/`$group`, 64-bit literals); clamp `maxRows` on fetch-style dialects (Oracle) and read duplicate-named DuckDB columns positionally; fix a Postgres connection-pool deadlock and scope few-shot/history stores per user; correct the guard's OFFSET-as-LIMIT handling; and answer broad schema and relationship questions from the full catalog, including foreign keys inferred from naming when none are declared.
- Updated dependencies [4294cdc]
  - @asksql/core@0.3.2

## 0.1.0

### Minor Changes

- Initial release: Oracle Database connector for AskSQL. Data-dictionary introspection (tables, views, columns, primary keys, foreign keys, table/column comments, row estimates) scoped to the current schema, and read-only query execution enforced with a per-query `SET TRANSACTION READ ONLY`. Uses the `oracledb` driver in pure-JS Thin mode (no Instant Client). Row cap enforced at the driver plus a hard slice; numeric fidelity preserved by fetching `NUMBER` as strings, `CLOB` as strings, and `BLOB` as buffers.
