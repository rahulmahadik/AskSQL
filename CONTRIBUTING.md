# Contributing to AskSQL

Thanks for your interest! AskSQL is a pnpm monorepo of small, focused packages.
This guide gets you from clone to green tests.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm** (`npm i -g pnpm`)
- Optional, only for the live test suites: local **PostgreSQL** and **MySQL**, a
  **Groq** API key (or a local **Ollama**), and **Google Chrome** for the
  browser E2E tests.

## Setup

```bash
pnpm install
pnpm typecheck   # tsc -b across every package
pnpm build       # ESM + .d.ts for every package
pnpm test        # the full suite (see gating below)
```

## Layout

| Path | What |
|------|------|
| `packages/core` | Engine: schema catalog, AST guard, NL->SQL pipeline, provider resolver |
| `packages/{postgres,mysql,sqlite,duckdb}` | Database connectors (drivers are peer deps) |
| `packages/server` | Credential-holding sidecar (auth, server-side guard, SSE) |
| `packages/react` / `packages/widget` | UI surfaces |
| `packages/mcp` | Model Context Protocol tool definitions |
| `packages/asksql` | Umbrella package with subpath exports |
| `examples/` | Runnable end-to-end demos |
| `tests/` | Cross-package integration + live tests |

## Tests

Unit and guard tests run with no external services. The live suites **self-skip**
when their dependency is absent, so `pnpm test` is green on a bare checkout.
To exercise them, provide:

- **Live databases** - `ASKSQL_PG_URL` (default `postgres://postgres:root@localhost:5432/asksql_test`)
  and `ASKSQL_MYSQL_HOST` / `ASKSQL_MYSQL_PORT` / `ASKSQL_MYSQL_USER` /
  `ASKSQL_MYSQL_PASSWORD` / `ASKSQL_MYSQL_DB`. SQLite and DuckDB are embedded.
- **A model** - `GROQ_API_KEY` for the cloud matrix, or `OLLAMA_URL` for a local
  model. Per-provider model overrides use `ASKSQL_<PROVIDER>_MODEL`.
- **Browser E2E** - a Chrome install; the tests drive it via `puppeteer-core`.

The security boundary is developed **test-first**: add or extend a case in the
`guard-security` / `guard-fuzz` suites before changing the guard.

## Code standards

- **TypeScript strict**; every new function parameter and return is typed.
- **Fail loud** - never swallow a decode/parse/decrypt error with a silent
  fallback.
- **No internal references in code** - no ticket, spec, or doc IDs in source,
  comments, or test names. This is a public codebase.
- **UI changes** work in both light and dark mode and show loading/empty/error
  states.
- Keep the public API surface intentional - export what hosts need, not internal
  helpers.

## Pull requests

1. Branch from `develop`.
2. `pnpm typecheck` and `pnpm test` must pass.
3. Describe what changed and why; link any related issue.
4. Contributions are accepted under the project's Apache-2.0 license.
