---
'@asksql/react': patch
'@asksql/server': patch
---

Bound the transcript: every turn kept its full result set for the life of a
session. Older turns now keep their text and drop their rows.

Switching connection in the picker no longer leaves the previous database's
transcript on screen, where Run or Explain would send SQL written for one schema
to another.

Server: the loopback allowlist no longer accepts 0.0.0.0, a request with no Host
is rejected, deleting a connection is gated like creating one, and a dynamic
connection string is parsed at the authority so credentials before an @ cannot
smuggle a different host past the private-address check.
