---
"@asksql/sqlite": patch
---

Keep duplicate result-column names distinct: read rows positionally when the driver supports it (better-sqlite3), and otherwise warn that a shared column name collapses to a single value. Expose the connected database (file) name for display.
