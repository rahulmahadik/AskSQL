---
"@asksql/core": patch
---

Scope query history per user in server mode: `HistoryEntry`, `AskOptions`, and the engine's execute path gain an optional `userId`, and `HistoryStore.list` filters by it, so one caller can no longer read another's questions and SQL. Surface a failed schema introspection instead of caching it — an empty table set accompanied by warnings now raises rather than looking like an empty database, and a partially-warned catalog uses a short cache TTL so transient faults self-heal. Block unbounded recursive CTEs on SQLite (a `WITH RECURSIVE` consumed by an aggregate, `GROUP BY`, or `DISTINCT` with no `LIMIT`) before they can hang a synchronous query. Add an optional `database` display name to the `Connector` contract.
