---
'@asksql/core': minor
'@asksql/react': patch
---

Let a follow-up refer to a query the answer suggested in prose.

Asked something a query alone cannot answer, AskSQL replies in prose, and that reply often ends in
a query. Saying "run that query" next used to be answered as a brand-new question, because only
turns that produced SQL were remembered and a prose turn produced none. The query came back as
`SELECT * FROM one_table`, and asking again got the honest but unhelpful reply that no previous
query existed - the model had never been shown one.

A prose answer now hands back the query it suggested, as `proposedSql`, and every surface records
that as the turn's query. Only a read-only query is carried: a write is offered as a proposal to
run by hand, and "run that" must never resolve to one.

"Run that query" is also recognised for what it is. It asks for the query already on screen rather
than a new one, which a model reads as a request it cannot answer from the schema, so it gave up
instead. It now reproduces the query it was shown.
