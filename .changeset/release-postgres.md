---
"@asksql/postgres": patch
---

Bound opt-in value sampling with a `SET LOCAL statement_timeout` on a dedicated client, so an unindexed column can no longer full-scan during introspection. Expose the connected database name for display.
