---
'@asksql/core': patch
---

Quote the identifiers a database would not read back as itself. A mixed-case Postgres schema failed
every query, because an unquoted name folds to lower case and resolves to nothing; Oracle folds the
other way, and MySQL on Linux compares table names case-sensitively. Table and column names are now
quoted from the catalog before the query is validated. A name that is already correct is left
untouched, so MySQL output is unchanged, and a name spelled two ways across the catalog is skipped
rather than guessed. A table named like a parser keyword, such as `order` or `Nulls`, also works now:
the bare form could not be parsed at all and the question failed after three attempts.

Reserved words now come from each database itself, through `pg_get_keywords()`,
`information_schema.KEYWORDS`, `V$RESERVED_WORDS` and `duckdb_keywords()`, rather than one shared list
that applied MySQL's rules to Postgres and missed most of MySQL's own: MySQL reserves 262 words where
the shared list had about a hundred. Regenerate with `node tools/generate-sql-keywords.mjs`.

Quoting knows where a word is syntax rather than a name, so `CAST(x AS DATE)` and
`EXTRACT(MONTH FROM d)` are left alone, and a CTE is still recognised once its name is quoted.

When a database rejects a name, the corrected query is derived from the catalog rather than from a
second model call, and the table repair names the closest match it already knew.

Tell the model which database and schema it is connected to. Without that it wrote
`table_schema = 'your_database_name'` against `information_schema` and returned nothing at all, which
reads as an empty database rather than an error. Structure questions also get a correct catalog query
for the engine to build on.

Say what is actually wrong when a statement will not parse. An apostrophe inside a value, as in
`'O'Brien'`, only produced "could not parse", so the model returned the same statement until it ran
out of attempts; it is now told to double the quote.

Reject `AVG(SUM(x))` before it reaches the database. Nested aggregates are invalid everywhere, so the
query is repaired rather than run and failed.

Fix two false alarms. A `UNION ALL` of per-table counts was blocked as a hallucinated column, because
each branch's columns were judged against every branch's tables; per-table row counts now work. Index
columns arrived already quoted from introspection and were quoted a second time, so every prompt
carried `"""ColumnName"""`.
