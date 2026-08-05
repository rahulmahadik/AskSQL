---
'@asksql/core': minor
---

Recognise a write request however politely it is phrased, and keep row values out of errors.

"can you delete all cancelled orders" used to come back as a SELECT. The pattern that recognises
a write request was anchored to the start of the question, so any preamble ("please", "can you",
"i need you to") hid it and the question was answered as if it asked for data. Those phrasings now
return the statement as a proposal AskSQL never runs, which is what every other phrasing already
did. A capability question ("can you delete my data?") still gets the answer written in code
rather than a proposed statement.

A destructive request is also recognised when it uses a verb other than the SQL keyword. "wipe the
orders table", "purge all old records", and the same phrasing with clear, erase, empty, flush or
nuke used to be answered as if they asked for data. The guard refused the statement either way, so
nothing was ever at risk; what was missing is that the user's intent went unacknowledged.

Routing was measured against a corpus of several thousand phrasings rather than a handful of
examples, which turned up five more gaps now closed: a column called `archived_at` no longer reads
as a request to archive data, "are there unused indexes on orders" is answered as advice instead of
a table listing, and "my joins on orders are slow", "the orders query is really slow" and
"is it worth archiving old orders" are recognised as questions about the schema rather than
questions about rows. The JetBrains plugin replays the same corpus, so the two implementations
cannot drift apart on it.

A total inflated by a one-to-many join is now caught and repaired. Summing `orders.total_cents`
while joined to `order_items` counts each order once per line item, which on the test fixture
doubles the figure; the query is valid, it runs, and nothing downstream can tell the inflated total
from the real one. The check reads the foreign keys already in the catalog, so it needs no
configuration and no assumptions about how anything is named. Aggregates over the child table,
`COUNT`, and `SUM(DISTINCT ...)` are left alone.

Oracle no longer fails outright on a `LIMIT` it cannot parse. Oracle has no LIMIT clause, so a
query carrying one used to reach the database and come back as ORA-03049, after the repair loop
had already finished. It is refused up front instead, which sends the query back to be rewritten
with the row cap applied the way Oracle expects.

Driver errors are redacted before they reach a caller: identifiers are kept, so "column x does not
exist" still says which column, but row values quoted back by the database are removed. A LIMIT
that has to be lowered is edited in place rather than re-serialized, which used to quote every
identifier in the statement and change `SELECT * FROM Orders` into `SELECT * FROM "Orders"`.
MongoDB catalogs strip sampled values at the single exit from `catalog()`, so no path can leak
them into a prompt while `allowDataInPrompt` is off.
