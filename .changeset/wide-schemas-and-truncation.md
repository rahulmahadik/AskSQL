---
"@asksql/core": minor
"@asksql/sqlite": minor
"@asksql/postgres": minor
"@asksql/mysql": minor
"@asksql/duckdb": minor
"@asksql/oracle": minor
---

A schema wider than about 50 tables used to leave every table past that point with no column hints
at all, since the probe budget was spent first-come rather than shared. It is now split fairly across
every table.

The schema pruner's table cap was a fixed 40 regardless of the token budget, so a wide schema could
drop a table the budget genuinely had room for; the cap now only guards against a pathological
schema, and the token budget decides what is actually sent. A single unusually wide table no longer
evicts every smaller table behind it in the same pass.

A result whose row cap was reached by the guard *lowering* an oversized LIMIT - rather than adding
one where there was none - is now correctly reported as truncated, on both the flag and the warning
text; previously only the "added a limit" case was caught.

DuckDB: introspecting a schema past 100,000 total columns no longer truncates the catalog silently.
Uploading a `.sql` dump over 20 MB is now rejected before it is read into memory, rather than risking
an out-of-memory crash partway through.

Oracle: the JSON-array column hint left one identifier unquoted, so a lower/mixed-case column name
produced a hint the database would reject with ORA-00904. Both branches now quote consistently.
