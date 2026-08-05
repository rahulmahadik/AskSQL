---
'@asksql/server': minor
---

Refuse client-supplied database file paths unless you opt in, and check the request origin on
every method.

A client could previously name any SQLite or DuckDB file the server process could read and have
its contents returned. A file path in a client-supplied connection is now refused with
`INVALID_INPUT` unless you set `allowFileEngines: true` or a non-empty `allowedFileRoots`, and a
path is resolved through its symlinks before it is compared against those roots, so a link
pointing out of an allowed directory no longer escapes it. `asksql serve` sets `allowFileEngines`
only when it binds a loopback address.

**This is a breaking change** for a deployment that relied on client-supplied file connections
working out of the box. Set `allowedFileRoots` to the directories you intend to expose; setting
only `allowFileEngines` permits any path the server process can read.

The cross-site check moved to the front of `handle()`, so the `Host` check and the content-type
gate now run for every method rather than only for those with a body, and both run before your
`auth` hook. Creating a connection requires the same authorization as using one. Addresses written
in decimal, hex, octal or IPv4-mapped IPv6 form are canonicalised before the link-local test, so
the cloud instance-metadata address cannot be reached by spelling it differently.
