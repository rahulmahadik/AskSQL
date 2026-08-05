---
'@asksql/mysql': patch
---

Stop a query timeout leaking onto the next query a pooled connection serves.

The execution cap was applied with `SET SESSION MAX_EXECUTION_TIME`, which outlives `release()`
and so capped whatever query the pooled connection served next, at whichever limit the previous
caller happened to ask for. It is now a statement-scoped hint on the query itself. The client-side
deadline is unchanged and still the real guarantee for a server that ignores the hint.
