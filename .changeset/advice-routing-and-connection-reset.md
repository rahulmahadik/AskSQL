---
'@asksql/core': patch
'@asksql/react': patch
---

Answer a question about what to change or improve in prose, rather than running a table listing. The
classifier matched "best practices" but not a misspelling of it, and not "what changes are needed",
so a question phrased either way fell through to SQL generation.

React: discard the transcript when the connection is removed and another takes its place. It was only
discarded when moving between two connections, so the old chat and its follow-up context carried onto
a different database. A `connectionId` prop changed after mount now takes effect too; it seeded the
initial state and was ignored afterwards, so the chat kept querying the first database.
