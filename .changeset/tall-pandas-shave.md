---
'@asksql/core': minor
---

Cap a set operation at the statement rather than inside a branch: a LIMIT written
in a parenthesised UNION branch bounds only that branch, so two branches of 900
could return 1800 rows against a cap of 1000. LIMIT ALL is rewritten to the cap
and a parameter or subquery count is blocked, matching the plain-select path.

New guard-free subpaths so a consumer can import what it needs without pulling the
SQL parser: `@asksql/core/providers` (model resolution, endpoint helpers) and
`@asksql/core/runtime` (error type, dialects, types). Both are additive.

New error codes `DB_NOT_FOUND` and clearer defaults across the taxonomy: several
messages named a cause they could not know, including one that claimed a retry had
happened when the caller may have disabled retries. `createAskSql` now rejects a
connector with no dialect instead of failing later while building a prompt.
