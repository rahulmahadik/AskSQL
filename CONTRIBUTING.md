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
pnpm typecheck     # tsc -b across every package
pnpm build         # ESM + .d.ts for every package
pnpm test          # the full suite (see gating below)
pnpm format:check  # prettier, as CI runs it
pnpm coverage      # what CI runs instead of `test`; the coverage floor applies only with --coverage
pnpm test:packaged # installs the packed tarballs outside the workspace and exercises every export
```

`test:packaged` is the one gate the in-repo suite cannot stand in for: pnpm's workspace links
resolve a dependency that is used but never declared, and a consumer's install does not.

## Layout

| Path | What |
|------|------|
| `packages/core` | Engine: schema catalog, AST guard, NL->SQL pipeline, provider resolver |
| `packages/{postgres,mysql,sqlite,duckdb,oracle,mongodb}` | Database connectors (drivers are peer deps) |
| `packages/server` | Credential-holding sidecar (auth, server-side guard, SSE) |
| `packages/react` / `packages/widget` | UI surfaces |
| `packages/mcp` | Model Context Protocol tool definitions |
| `packages/vscode` | VS Code extension. Private, versioned and released on its own line - not part of the npm release |
| `packages/browser-extension` | Edge/Chrome extension (Manifest V3). Private, versioned and released on its own line - not part of the npm release |
| `packages/jetbrains` | JetBrains plugin. A standalone Gradle project with no `package.json`, invisible to the pnpm workspace and released on its own line |
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
2. `pnpm build`, `pnpm format:check`, `pnpm coverage` and `pnpm test:packaged` must pass - that is what CI runs.
3. Describe what changed and why; link any related issue.
4. Contributions are accepted under the project's Apache-2.0 license.

## Releasing (maintainers)

Versions are managed by [changesets](https://github.com/changesets/changesets); publishing
runs in CI so packages carry npm [provenance](https://docs.npmjs.com/generating-provenance-statements).

### Every change that ships

```sh
pnpm changeset          # pick the packages and the bump, describe the change
```

The changeset file is committed with the PR. Do **not** hand-edit `version` in a
`package.json` - that skips the changelog and leaves the changeset state lying.

### Cutting a release

```sh
pnpm changeset:version  # bumps versions + writes each package's CHANGELOG
git commit -am "Release: <summary>"
git push
git tag -a v0.1.2 -m "Release: <summary>" && git push origin v0.1.2
```

Annotate the tag. Its message becomes the GitHub Release body; a lightweight tag leaves that
body empty.

`changeset:version` runs `tools/release-preflight.mjs` first, which refuses to continue if any
package would be bumped to a **major** that no changeset asked for. That is not hypothetical:
changesets majors any package whose *peer* dependency receives a non-patch bump, so a changeset
saying `'@asksql/server': minor` once produced `1.0.0` because `@asksql/sqlite` went up a minor.
npm versions cannot be withdrawn, so this is checked before the numbers are written rather than
after. If a major genuinely is intended, declare it in a changeset and the preflight passes.

Two rules keep that trap shut, both enforced by `tests/peer-ranges.test.ts`:

- **Never use `workspace:*` (or `workspace:~`) in `peerDependencies`.** pnpm replaces it with the
  exact current version on publish, so `@asksql/server` would demand one precise connector build
  and every connector release would put consumers into a peer conflict. Use `workspace:>=0.1.0`:
  what a connector must satisfy is the `Connector` interface from `@asksql/core`, which is a
  normal dependency, so any published connector version is genuinely compatible.
- **Keep `onlyUpdatePeerDependentsWhenOutOfRange` set** in `.changeset/config.json`. Without it
  changesets ignores the range entirely and majors on any non-patch peer bump.

The tag triggers `.github/workflows/release.yml`. It first refuses to continue unless the tag is
an ancestor of `main` and its version matches `packages/core/package.json` - npm cannot unpublish,
so a mistagged cut is not recoverable. Then it installs, builds, runs `pnpm coverage`, and waits
for an approval before publishing all eleven packages with provenance and creating the GitHub
Release. The VS Code extension and the browser extension are `private: true`, so changesets skips
both, and `packages/jetbrains` has no `package.json` at all. Each of the three is versioned and
released separately, on its own line.

Afterwards, anyone can verify what they installed:

```sh
npm audit signatures
```

### One-time GitHub setup

**Settings > Environments > New environment > `npm-publish`**

| Setting | Value | Why |
|---|---|---|
| Environment secret `NPM_TOKEN` | npm **Automation** token | Scoped to this job, not readable by other workflows. |
| Required reviewers | a maintainer | Approval gate before publish. |
| Deployment branches and tags | Selected -> tag rule `v*` | Only release tags reach the token. |
| Allow administrators to bypass | **unchecked** | Otherwise the approval gate does not apply to admins. |
| Prevent self-review | **unchecked** | A single maintainer must be able to approve their own release. |

Tag patterns are case-sensitive: `v*` matches `v0.1.2`, `V*` matches nothing. A
`workflow_dispatch` run must select a **tag** in the ref dropdown; a branch cannot
reach this environment.

### Why the dependency ranges are `workspace:^`

`workspace:*` publishes as an **exact** pin (`"@asksql/core": "0.1.1"`). A core-only
fix would then reach nobody: installing `@asksql/postgres@0.1.1` pulls exactly
`@asksql/core@0.1.1`, bug and all. `workspace:^` publishes as `^0.1.2`, so a patch to
core flows to every dependant without republishing all eleven.
