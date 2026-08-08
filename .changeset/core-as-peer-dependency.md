---
'@asksql/duckdb': minor
'@asksql/mcp': minor
'@asksql/mongodb': minor
'@asksql/mysql': minor
'@asksql/oracle': minor
'@asksql/postgres': minor
'@asksql/react': minor
'@asksql/server': minor
'@asksql/sqlite': minor
---

Depend on `@asksql/core` as a peer rather than a regular dependency. As a regular dependency, a
consumer pinned to a different core minor got a second copy of core installed under the connector
instead of a resolution error. Structural types survive that; identity does not, so
`error instanceof AskSqlError` was false for every error the connector threw and consumer error
handling silently stopped matching. The peer range is `>=0.6.0`, so npm and pnpm install one shared
core and report a real conflict when the consumer's pin cannot satisfy it.

Yarn (classic and berry) and npm with `legacy-peer-deps` do not install peers, so on those
`@asksql/core` must now be installed explicitly alongside the package.
