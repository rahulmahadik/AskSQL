---
"@asksql/core": patch
"@asksql/duckdb": patch
"@asksql/postgres": patch
"@asksql/mongodb": patch
"@asksql/oracle": patch
"@asksql/react": patch
"@asksql/server": patch
---

Security and reliability hardening. Broaden the DuckDB `.sql` upload denylist to the full reader/scan family (blocks `read_csv_auto`, `read_blob`, `parquet_scan`, and quoted-path reads); bound the Mongo regex and aggregation guards (all regex carriers, unbounded `$push`/`$group`, 64-bit literals); clamp `maxRows` on fetch-style dialects (Oracle) and read duplicate-named DuckDB columns positionally; fix a Postgres connection-pool deadlock and scope few-shot/history stores per user; correct the guard's OFFSET-as-LIMIT handling; and answer broad schema and relationship questions from the full catalog, including foreign keys inferred from naming when none are declared.
