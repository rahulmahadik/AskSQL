---
'@asksql/core': patch
'@asksql/react': minor
---

Clamp the MongoDB row cap the way the SQL side already did. A `maxRows` that was fractional, zero or
negative was passed straight into `$limit`, which MongoDB rejects outright, so the query failed
rather than returning fewer rows; a value above the engine's ceiling was injected unclamped while
the surrounding warning text named the capped number. Both engines now resolve the cap through one
shared function, so the prompt, the injected limit and the warning always name the same figure.

Stop reporting a backticked placeholder as a name missing from your schema. Backticks wrap more than
identifiers, so `` `?` ``, a date, or `:param` were each reported as a table or column that does not
exist. Hyphenated names, which are legal inside backticks, are still checked.

React: copy controls on explanations, schema answers, the query plan and the result grid; the
model's output is shown as it streams; the thread only follows new content when you are already at
the bottom; a schema answer no longer renders a red error while it is still being written; truncated
cells carry their full value; and `maxRows` takes effect on the next question rather than when the
connection changes.
