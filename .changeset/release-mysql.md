---
"@asksql/mysql": patch
---

Enforce a real query deadline that also works on MariaDB: set both `MAX_EXECUTION_TIME` and `max_statement_time`, plus a client-side deadline that `KILL`s the backend when a query overruns. Keep duplicate result-column names distinct by reading rows positionally. Expose the connected database name for display.
