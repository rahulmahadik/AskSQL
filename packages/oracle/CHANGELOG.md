# @asksql/oracle

## 0.1.0

### Minor Changes

- Initial release: Oracle Database connector for AskSQL. Data-dictionary introspection (tables, views, columns, primary keys, foreign keys, table/column comments, row estimates) scoped to the current schema, and read-only query execution enforced with a per-query `SET TRANSACTION READ ONLY`. Uses the `oracledb` driver in pure-JS Thin mode (no Instant Client). Row cap enforced at the driver plus a hard slice; numeric fidelity preserved by fetching `NUMBER` as strings, `CLOB` as strings, and `BLOB` as buffers.
