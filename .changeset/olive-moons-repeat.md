---
'@asksql/postgres': patch
'@asksql/mysql': patch
'@asksql/oracle': patch
'@asksql/mongodb': patch
'@asksql/sqlite': patch
'@asksql/duckdb': patch
---

Report what actually failed when a connection is refused: a wrong password or a
database that does not exist is no longer reported as an unreachable server, which
sent users to check a host and port that were fine.

Return every value as the database stored it: exact numerics keep their type and
precision, NaN and Infinity survive, bigints nested in objects are not coerced, and
leading, trailing or whitespace-only strings arrive with their spaces intact.

A connection whose query timed out is dropped rather than rolled back and returned
to the pool, where it could hand the next caller a statement still running.
