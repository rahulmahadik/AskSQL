# Security Policy

AskSQL's core promise is that a natural-language question can never run a
destructive query. If you find a way to break that promise, we want to hear
from you before anyone else does.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
on the repository page, go to **Security -> Report a vulnerability**. This opens
a private advisory visible only to the maintainers.

Include, where possible:

- the affected package and version,
- a minimal reproduction (the question/SQL and connector/dialect involved),
- what you expected vs. what happened.

We aim to acknowledge a report within a few days and to ship a fix or mitigation
for confirmed high-severity issues promptly. Coordinated disclosure is
appreciated - we'll credit you in the advisory unless you prefer otherwise.

## What's in scope

The security boundary is the AST-based read-only guard and the isolation around
untrusted input. High-value targets:

- **Guard bypass** - any input that makes a write, DDL, stacked statement,
  data-modifying CTE, `SELECT INTO`/`INTO OUTFILE`, locking clause, or a
  denylisted dangerous function pass as an allowed read-only query.
- **Arbitrary file / URL reads** via DuckDB replacement scans or file-reading
  functions (`read_csv`, `parquet_*`, etc.) in a relation position.
- **SSRF** through any outbound request to a user-influenced URL.
- **Credential exposure** - a token, password, or connection string leaking into
  an API response, log line, or error message.
- **Cross-tenant / cross-connection access** in the server sidecar's auth layer.

## What's not a vulnerability

- A model generating a *wrong but read-only* query (that's a quality issue).
- Behavior only reachable by a trusted operator who already holds write
  credentials to the database.
- Findings against the example apps or internal-only tooling.

## Defense in depth

Even if the guard were bypassed, connectors open **read-only** database sessions,
so a slipped write still hits a read-only transaction. Report guard bypasses
regardless - the read-only session is a backstop, not the boundary.
