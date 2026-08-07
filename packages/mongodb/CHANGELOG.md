# @asksql/mongodb

## 0.1.5

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

## 0.1.4

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

## 0.1.3

### Patch Changes

- Updated dependencies [3c4c92b]
  - @asksql/core@0.4.0

## 0.1.2

### Patch Changes

- f440790: Default the separate user/password `authSource` to `admin` (fixes authentication for root/Atlas users, who don't live in the query database; overridable via a new `authSource` option), and give clearer connection errors - an Atlas IP allow-list hint on a TLS/timeout failure, and a note about the `<password>` placeholder brackets on an auth failure.
- Updated dependencies
  - @asksql/core@0.3.4

## 0.1.1

### Patch Changes

- 4294cdc: Security and reliability hardening. Broaden the DuckDB `.sql` upload denylist to the full reader/scan family (blocks `read_csv_auto`, `read_blob`, `parquet_scan`, and quoted-path reads); bound the Mongo regex and aggregation guards (all regex carriers, unbounded `$push`/`$group`, 64-bit literals); clamp `maxRows` on fetch-style dialects (Oracle) and read duplicate-named DuckDB columns positionally; fix a Postgres connection-pool deadlock and scope few-shot/history stores per user; correct the guard's OFFSET-as-LIMIT handling; and answer broad schema and relationship questions from the full catalog, including foreign keys inferred from naming when none are declared.
- Updated dependencies [4294cdc]
  - @asksql/core@0.3.2

## 0.1.0

### Minor Changes

- Initial release: MongoDB connector implementing the `MongoConnector` contract. Sampling-based schema inference across collections (dotted field paths, BSON type inference, presence stats, opt-in example values) and guarded read-only aggregation-pipeline execution with truncation detection, cancellation, and numeric fidelity (Long / Decimal128 travel as strings).
