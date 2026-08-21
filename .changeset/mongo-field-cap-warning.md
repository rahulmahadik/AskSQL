---
"@asksql/mongodb": patch
---

A collection with more than 500 distinct fields silently described only the first 500 to the model,
with no signal anything was left out. A warning is now included when that cap is hit.
