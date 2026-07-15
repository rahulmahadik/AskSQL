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

The guard is the boundary. Behind it, each connector adds a backstop that does
not depend on the guard's lexer agreeing with the server's parser:

| Connector | Behind the guard |
|---|---|
| Postgres | `BEGIN READ ONLY`, plus the **extended query protocol** - one statement per message, so multi-statement text is rejected by the server |
| MySQL | `START TRANSACTION READ ONLY`; `mysql2` defaults `multipleStatements` to false |
| SQLite | the handle is opened read-only; `prepare()` compiles a single statement |
| DuckDB | a **prepared statement** - exactly one statement, rejected otherwise |

DuckDB is the one engine with **no read-only session** (`readOnlySession: false`),
because it must create views over the files you load. Its prepared statement is
therefore load-bearing, not a nicety.

Report guard bypasses regardless. These backstops are a second line, not the
boundary - and a bypass that only a backstop catches is still a bug.

## Scanner alerts, and what they mean

Automated scanners (Socket, Snyk, `npm audit`) report on the whole dependency
graph. The alerts below come from dependencies, not from AskSQL's own code. Each
is checkable with the command shown.

**AskSQL's own code has no `eval`, no shell access, no filesystem access, and no
network calls of its own, in any of the nine packages.**

### "Uses eval" / "Obfuscated code"

Source: `node-sql-parser`, the parser the guard uses. The flagged code is the
`globalThis` polyfill every bundler emits:

```js
r = function () { return this }();
try { r = r || new Function("return this")(); } catch (t) { /* ... */ }
```

That is not dynamic execution of SQL or anything else, and it lives only in the
package's 15 minified `umd/*.umd.js` **browser** bundles (minified is what trips
the obfuscation heuristic). `node-sql-parser` declares no `browser`, `exports`,
or `module` field - only `main: index.js` - so Node and bundlers both resolve
`index.js`, which contains **zero** `eval`. The UMD files are reachable only by
deep-importing `node-sql-parser/umd/...`, which AskSQL never does. Check it:

```sh
P=$(node -e "console.log(require.resolve('node-sql-parser'))")
echo "$P"                             # -> .../node-sql-parser/index.js
grep -c "eval(\|new Function(" "$P"   # -> 0
```

### "Network access" / "URL strings" / "Environment variable access"

Source: `pg`, `mysql2`, `ai`, `@ai-sdk/*`. A Postgres driver connects to Postgres
and reads `PGHOST`; an AI SDK calls a model endpoint and reads an API key. This
is the job.

### "Shell access"

Source: `cross-spawn` (via `@modelcontextprotocol/sdk`, which spawns MCP servers
over stdio) and `detect-libc` (via `better-sqlite3`, which detects glibc/musl to
pick a prebuilt binary). Both arrive only through **optional peer dependencies**:
if you do not install the MCP SDK or `better-sqlite3`, neither is in your tree.

### "Unmaintained" (not updated in five years)

This alert is **accurate**. The packages are `pg` and `mysql2` internals:
`is-property` (2014), `pg-int8` (2017), `xtend` (2019), `pg-types` (2019),
`postgres-array`, `postgres-date`, `postgres-interval`, `generate-function`,
`safer-buffer`. They are small, finished packages that the standard Postgres and
MySQL drivers depend on. `pg` and `mysql2` are themselves actively maintained and
together serve over 40 million downloads a week - every Node application talking
to Postgres or MySQL has exactly these in its tree. Removing them would mean not
using the standard drivers.

### "New author"

AskSQL is new. Time is the only fix.

## What AskSQL itself ships

- **No install scripts.** Nothing compiles or downloads when you install any
  `@asksql/*` package.
- **A small tree.** `npm i @asksql/core` installs six packages: `ai`,
  `node-sql-parser`, three `@ai-sdk/*`, and `big-integer`.
- **Drivers are optional peers.** You install only the one you use, so you choose
  your own trust surface.

## Choosing a SQLite driver

`@asksql/sqlite` accepts either driver. It is a real choice:

| | `node:sqlite` (built in) | `better-sqlite3` |
|---|---|---|
| Install | nothing - built into Node 22.5+ | native module: `prebuild-install \|\| node-gyp rebuild` |
| Scanner alerts | none | install script, shell access (`detect-libc`) |
| Works with `--ignore-scripts` | yes | no |
| Integers above 2^53 | throws, or exact BigInts with `readBigInts: true` | returns a lossy number |
| Node 20 | not available | works |

Neither is wrong. `node:sqlite` costs nothing to install and refuses to lose
precision silently; `better-sqlite3` is battle-tested and supports Node 20. Pass
whichever you have:

```js
// Zero dependencies, Node 22.5+
import { DatabaseSync } from 'node:sqlite';
new SqliteConnector({ id: 'app', name: 'App', database: new DatabaseSync('app.db', { readOnly: true }) });

// Or the native driver
import Database from 'better-sqlite3';
new SqliteConnector({ id: 'app', name: 'App', database: new Database('app.db', { readonly: true }) });
```

## Provenance

From 0.1.2, packages are published by GitHub Actions with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements): a
signed attestation tying each tarball to the commit and workflow that built it.
Verify what you installed:

```sh
npm audit signatures
```
