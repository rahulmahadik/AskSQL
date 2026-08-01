# AskSQL for JetBrains IDEs

**[Install from the JetBrains Marketplace](https://plugins.jetbrains.com/plugin/33126-asksql)**

[![Version](https://img.shields.io/jetbrains/plugin/v/33126?label=Marketplace)](https://plugins.jetbrains.com/plugin/33126-asksql)
[![Downloads](https://img.shields.io/jetbrains/plugin/d/33126?label=Downloads)](https://plugins.jetbrains.com/plugin/33126-asksql)


AI database chat inside any JetBrains IDE (IntelliJ IDEA, DataGrip, PyCharm, WebStorm,
GoLand, PhpStorm, Rider, CLion, RubyMine, RustRover, Android Studio): ask a question in
plain language, review the generated SQL, approve it, and get results.

## Compatibility

AskSQL depends only on `com.intellij.modules.platform`, so it installs in **every
IntelliJ-Platform IDE, 2025.2 and newer** (build 252+), including the Ultimate/paid and
free editions alike. Fleet is not supported (it does not use the IntelliJ Platform plugin
model).

Every release is run through the JetBrains **Plugin Verifier** against 12 IDEs, all
reporting **Compatible** with zero compatibility problems:

| IDE | IDE |
| --- | --- |
| IntelliJ IDEA Community (2025.2 floor) | IntelliJ IDEA Community (2025.3) |
| IntelliJ IDEA Ultimate | PyCharm Professional |
| WebStorm | PhpStorm |
| GoLand | Rider |
| CLion | RubyMine |
| RustRover | Android Studio |

DataGrip is supported at runtime on the same platform APIs, but is not in the automated
matrix: the Plugin Verifier's release-feed lookup for its product code is broken upstream,
which is a tooling limitation rather than an incompatibility.

This is a **standalone Gradle project**: it is deliberately invisible to the root
pnpm workspace (no `package.json` anywhere under this directory tree; see
`.github/workflows/jetbrains-ci.yml`'s `isolation-guard` job, which fails the build if
that ever changes). Everything here is **pure Kotlin/JVM**: no Node.js runtime, no
child process, no sidecar. See `../../internal/JETBRAINS-PLUGIN-PLAN.md` (repo-internal)
for the full architecture rationale.

## Screenshots

![AskSQL tool window after install: no connections yet, with steps to connect a database and choose an AI model](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/onboarding.png)

![Schema tree browsing a connected MySQL database above the chat panel, with sample questions to get started](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/schema-and-chat.png)

![AskSQL settings configured against a local Ollama model, no API key needed](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/settings-ollama.png)

![The AI provider dropdown in settings, listing OpenAI, Anthropic, Gemini, Groq, Ollama and the rest](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/settings-providers.png)

## Getting started (using the plugin)

1. Install it from the JetBrains Marketplace: **Settings/Preferences → Plugins →
   Marketplace** → search for **AskSQL** → Install. (To run a local build instead:
   `./gradlew buildPlugin` from this directory produces
   `build/distributions/asksql-jetbrains-<version>.zip`, which installs via
   **Plugins → ⚙ → Install Plugin from Disk...**.)
2. Restart the IDE when prompted.
3. Open the **AskSQL** tool window (usually a tab on the right/bottom edge).
4. **Add a connection**: on the empty-state screen, click **Add Connection** (Postgres,
   MySQL, SQLite, DuckDB, Oracle, or MongoDB), or click **Try sample data** for a
   ready-made SQLite database with no setup, good for a first look.
5. **Configure a model**: click **Configure a provider** to add an API key for
   OpenAI/Anthropic/Gemini/Groq/NVIDIA/etc., or **Use a local model** if you already
   have Ollama or LM Studio running (detected automatically, no API key needed).
6. Type a question in plain language, review the generated SQL (and, unless you turned
   off "require approval" in Settings, click **Run**), and see the result. Nothing
   executes without going through the read-only guard first, regardless of this setting;
   see "Security and privacy invariants" below.

The schema tree above the chat browses every configured connection's tables/columns
without needing to ask a question first; drag the divider to resize either panel.

## Querying CSV, Excel and Parquet files (no database needed)

Click **Query CSV, Excel or Parquet Files** (the import icon in the AskSQL tool window title bar) to
query flat files without a database server. Select one or more **CSV, JSON, NDJSON, Parquet,
XLSX, or portable `.sql`** files at once; each becomes a table in a single DuckDB connection,
so you can join across them straight away. Pick a fresh connection or add the files to an
existing set. DuckDB powers this under the hood, so there is no server to install.

(A DuckDB connection's **File path** in the Add Connection wizard points at one existing
`.duckdb` database file, or is left blank for a private in-memory database; use **Query CSV,
Excel or Parquet Files** above to load data files, not the wizard's file browser.)

## Requirements

- JDK 21 (auto-provisioned by the Gradle toolchain via the foojay resolver if not
  already installed; no manual setup needed).
- Docker, only if you want to run the Testcontainers-backed integration tests
  (`./gradlew test -PintegrationTests=true`). Everything else (build, unit tests,
  `runIde`) needs no Docker.
- Node.js 18+, only for `./gradlew parityVectors` (see below). Never required to build
  or run the plugin itself.

## Dev loop

```bash
./gradlew runIde          # launches a sandboxed IDE with the plugin installed
./gradlew test            # fast unit tests (guard, prompts, catalog pruning, ...)
./gradlew test -PintegrationTests=true # Testcontainers-backed tests (needs Docker)
./gradlew buildPlugin     # produces build/distributions/*.zip
./gradlew verifyPlugin    # IntelliJ Plugin Verifier against the configured IDE matrix
```

## Parity tooling (`tools/parity/`)

The Kotlin SQL guard and prompt builders are ports of `@asksql/core` (the npm engine
used by the VS Code extension and `@asksql/server`), re-architected around JSqlParser
and JDBC instead of node-sql-parser and Node's DB drivers. To keep the Kotlin guard
from silently drifting from the published core's security behavior, `tools/parity/`
runs a corpus of SQL statements through the **published** `@asksql/core` package and
records the verdicts as committed JSON vectors (`vectors/guard.json`,
`vectors/prompts.json`). `GuardVectorTest` and `PromptParityTest` replay those vectors
against this Kotlin port in every `./gradlew test` run.

```bash
./gradlew parityVectors   # regenerates tools/parity/vectors/*.json (needs Node + npm)
git diff tools/parity/vectors/  # review before committing; CI fails on any diff
```

The parity contract is a **subset**, not equality: the Kotlin guard must never allow
what core blocks (checked and enforced); it may occasionally block something core
allows, if JSqlParser's grammar coverage differs from node-sql-parser's; that
direction is safe (a stricter guard, not a weaker one) and is logged, not failed.

Node is used **only** by this tooling, in CI and in local dev; never bundled into
the plugin, never required on an end user's machine.

## Architecture at a glance

```
com.rahulmahadik.asksql.ide/
├── model/       Dialect, SchemaCatalog, ResultSet, GuardPolicy, EngineEvent,
│                MongoGuardPolicy/MongoGuardVerdict: pure data
├── guard/       SqlGuard (JSqlParser AST walk), SqlLexer, DenyLists: the SQL engines'
│                security boundary; MongoGuard/MongoDenyLists: MongoDB's separate,
│                allowlist-first equivalent (no server-enforced read-only floor exists
│                for Mongo, so the guard alone carries that guarantee)
├── engine/      EnginePipeline (ask/execute/explain/suggestFix) for the five SQL
│                engines, Prompts, Extract, CatalogPruner (shared with Mongo),
│                HallucinationChecks, HistoryStore (in-memory only);
│                MongoEnginePipeline/MongoPrompts/MongoExtract: MongoDB's own,
│                non-SQL pipeline (see the class doc on MongoGuard for why this
│                isn't just a parameterization of EnginePipeline)
├── llm/         LlmClient (OpenAI-compatible / Anthropic / Gemini over java.net.http),
│                ModelDiscovery (Ollama/LM Studio zero-key probing), BaseUrlGuard
├── db/          ConnectionRegistry (project service), JdbcConnectionFactory,
│                ReadOnlySession, JdbcExecutor, DriverProvisioner, db/introspect/*
│                (Postgres/MySQL/SQLite/DuckDB/Oracle, JDBC-based);
│                MongoClientRegistry/MongoClientFactory/MongoQueryExecutor,
│                db/introspect/MongoIntrospector (sampling-based schema inference,
│                no catalog to query): MongoDB's separate, non-JDBC connection path
├── settings/    AskSqlAppSettings / AskSqlProjectSettings (SerializablePersistentStateComponent),
│                AskSqlSecrets (PasswordSafe), ConnectionMerger, Configurables
├── ui/          Tool window: ChatPanel, TranscriptView, TurnPanel, SqlBlockPanel,
│                ApprovalBar, ResultTablePanel, SchemaTreePanel, OnboardingPanel
├── actions/     AddConnection, TrySampleData, UploadFileToDuckDb, RefreshSchema,
│                OpenSettings, AskAboutSelection, OpenSqlInScratch, CollectDiagnostics
└── integrations/database/  Optional, purely-reflective DataGrip datasource import
```

Security and privacy invariants (see the plan doc for the full list):

- The AST guard (`SqlGuard`) runs on **every** SQL string before **every** execution
  (MongoDB: `MongoGuard`, on every generated pipeline).
- Every JDBC session is additionally forced read-only at the engine level
  (`ReadOnlySession`): defense in depth beyond the guard. MongoDB has no
  session/connection-level read-only flag to arm the same way, so for that
  engine `MongoGuard` is the only floor, not defense-in-depth alongside one
  (see its class doc).
- Only schema is ever sent to the configured AI model. On the SQL engines that means declared
  values only - a column's `ENUM` labels come from the DDL, not from anyone's rows. MongoDB has
  no DDL to declare them, so its introspector samples a few distinct **values** per field (up to
  24, capped in length) so the model can write correct filters against real status codes. Full
  row data (arbitrary query results) is never sent on any engine.
- Chat history and query results are **in-memory only**; nothing is written to disk
  except settings, and secrets live only in the OS keychain via PasswordSafe.
- Zero telemetry.

## Required database privileges

AskSQL only ever runs read-only statements (enforced by the guard plus, on most
engines, the session itself, see above), so the connecting user needs no write
grants. A dedicated, read-only account is recommended over reusing an
application's own credentials:

- **Postgres**: `GRANT CONNECT ON DATABASE <db> TO <user>;` plus
  `GRANT USAGE ON SCHEMA <schema> TO <user>;` and
  `GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO <user>;` (and
  `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES` so future tables inherit
  it). Introspection also reads `pg_catalog`/`information_schema`, which is
  world-readable by default.
- **MySQL**: `GRANT SELECT, SHOW VIEW ON <db>.* TO '<user>'@'%';`: `SHOW VIEW` is
  needed for view definitions during introspection, not for querying.
- **Oracle**: `GRANT CREATE SESSION TO <user>;` plus `SELECT` on the target
  objects (or `SELECT ANY TABLE` for a schema-wide read-only account).
  Introspection reads only the `ALL_*` data dictionary views (`ALL_TAB_COMMENTS`,
  `ALL_COL_COMMENTS`, `ALL_TABLES`, `ALL_OBJECTS`), never `DBA_*`, so no extra
  catalog role is needed beyond the object grants above; `ALL_*` views already
  show whatever the connecting user has been granted.
- **MongoDB**: the built-in `read` role on the target database (`db.grantRolesToUser`)
  is sufficient; introspection samples documents and reads `listCollections`/
  `listIndexes`, all covered by `read`.
- **SQLite / DuckDB**: file-based; whatever OS file permission lets the IDE
  process open the file is the only "grant" that applies; the plugin additionally
  opens the file itself in read-only mode (see `ReadOnlySession`).

## Debugging the plugin

`./gradlew runIde` launches a sandboxed IDE attached to your run/debug configuration;
set breakpoints in this Kotlin code exactly as you would for any other JVM app; there
is no separate sidecar process to attach to.
