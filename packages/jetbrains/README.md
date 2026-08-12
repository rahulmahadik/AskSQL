# AskSQL for JetBrains IDEs

**[Install from the JetBrains Marketplace](https://plugins.jetbrains.com/plugin/33126-asksql)**

[![Version](https://img.shields.io/jetbrains/plugin/v/33126?label=Marketplace)](https://plugins.jetbrains.com/plugin/33126-asksql)
[![Downloads](https://img.shields.io/jetbrains/plugin/d/33126?label=Downloads)](https://plugins.jetbrains.com/plugin/33126-asksql)


AI database chat inside any JetBrains IDE (IntelliJ IDEA, DataGrip, PyCharm, WebStorm,
GoLand, PhpStorm, Rider, CLion, RubyMine, RustRover, Android Studio): ask a question in
plain language, review the generated SQL, approve it, and get results.

## Screenshots

![AskSQL tool window after install: no connections yet, with steps to connect a database and choose an AI model](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/onboarding.png)

![Schema tree browsing a connected MySQL database above the chat panel, with sample questions to get started](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/schema-and-chat.png)

![AskSQL settings configured against a local Ollama model, no API key needed](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/settings.png)

![The AI provider dropdown in settings, listing OpenAI, Anthropic, Google, Groq, Ollama, an OpenAI-compatible endpoint, LM Studio and NVIDIA](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/settings-ai-providers.png)

![A query result drawn as a bar chart, with a Table toggle beside Export CSV, Copy, Open in Editor and Explain](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/show-chart.png)

![Adding a database connection from the AskSQL settings page](https://github.com/rahulmahadik/AskSQL/raw/HEAD/packages/jetbrains/images/settings-add-db-connection.png)

## Getting started (using the plugin)

1. Install it from the JetBrains Marketplace: **Settings/Preferences → Plugins →
   Marketplace** → search for **AskSQL** → Install. (To run a local build instead:
   `./gradlew buildPlugin` from this directory produces
   `build/distributions/asksql-jetbrains-<version>.zip`, which installs via
   **Plugins → ⚙ → Install Plugin from Disk...**.)
2. Restart the IDE when prompted.
3. Open the **AskSQL** tool window (a tab on the right edge).
4. **Add a connection**: on the empty-state screen, click **Add Connection** (Postgres,
   MySQL, SQLite, DuckDB, Oracle, or MongoDB), or click **Try sample data** for a
   ready-made SQLite database with no setup, good for a first look.
5. **Configure a model**: click **Configure a provider** to add an API key for
   OpenAI/Anthropic/Gemini/Groq/NVIDIA/etc., or **Use a local model** if you already
   have Ollama or LM Studio running (detected automatically, no API key needed).
6. Type a question in plain language, review the generated SQL (and, unless you turned
   off "require approval" in Settings, click **Run**), and see the result. Nothing
   executes without going through the read-only guard first, regardless of this setting;
   see "Security and privacy" below.

The schema tree above the chat browses every configured connection's tables/columns
without needing to ask a question first; drag the divider to resize either panel.
Right-click a connection for **Describe This Database** (what it is for, how the tables
relate, how many there are), or a table for **Ask About This Table**.

## Querying CSV, Excel and Parquet files (no database needed)

Click **Query CSV, Excel or Parquet Files** (the import icon in the AskSQL tool window title bar) to
query flat files without a database server. Select one or more **CSV, TSV, TXT, JSON, NDJSON,
Parquet, Excel (`.xlsx`/`.xls`), or portable `.sql`** files at once; each becomes a table in a single DuckDB connection,
so you can join across them straight away. Pick a fresh connection or add the files to an
existing set. DuckDB powers this under the hood, so there is no server to install.

(A DuckDB connection's **File path** in the connection editor takes an existing `.duckdb`
database, data files to load as tables, or nothing at all for a private in-memory database.
Adding data files to a connection that already has some keeps what is already there.)

## Troubleshooting

**"Fetch Models" returns nothing.** For Ollama or LM Studio, the runtime has to be running first
(`ollama serve`, or start LM Studio's server) and the Base URL has to point at it. For a hosted
provider, the API key must be saved before models can be listed, and Anthropic, Google and Azure
publish no listing endpoint at all - type the model name instead.

**Test Provider fails.** It makes a real model call, so it fails for a real reason: a wrong key
(`LLM_AUTH`), a model name the provider does not have (usually a 404), or a Base URL pointing
somewhere else. The message says which.

**A query is blocked because a column "does not exist".** The model invented a name. AskSQL checks
every table and column against your schema before running anything, hands the model the real column
list, and asks again. If it still fails you get the names that do exist, so you can rephrase.

**The numbers are out by a factor of 100.** Almost always a column that stores a minor unit, like
`total_cents`. Nothing in the column's type says so, so tell AskSQL once: comment the column in your
database (`COMMENT ON COLUMN orders.total_cents IS 'cents; divide by 100 for dollars'`), and every
answer after that converts it. Comments travel into the prompt with the rest of the schema.

**A total looks too high on a query with joins.** Joining a table to its children multiplies the
rows being summed. AskSQL detects this from your foreign keys and rewrites the query, but review
the SQL on anything involving several one-to-many joins.

**New tables are missing after loading files.** Use **Refresh Schema** in the tool window. Schemas
are cached for five minutes, and a refresh re-reads every connection.

**Answers are weak on complex questions.** Model size is the biggest factor. A 7B such as
`qwen2.5-coder:7b` handles multi-join analytics; a 1.5B-3B is fine for single-table questions but
slips on window functions and deep joins.

## Required database privileges

AskSQL only ever runs read-only statements (enforced by the guard and, on most engines, by the session itself; see above), so the connecting user needs no write
grants. A dedicated, read-only account is recommended over reusing an
application's own credentials:

- **Postgres**: `GRANT CONNECT ON DATABASE <db> TO <user>;` plus
  `GRANT USAGE ON SCHEMA <schema> TO <user>;` and
  `GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO <user>;` (and
  `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES` so future tables inherit
  it). Introspection also reads `pg_catalog`/`information_schema`, which is
  world-readable by default.
- **MySQL**: `GRANT SELECT, SHOW VIEW ON <db>.* TO '<user>'@'%';` (`SHOW VIEW` is needed for view
definitions during introspection, not for querying).
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

## Security and privacy

These hold on every engine (the plan doc carries the full list):

- The AST guard (`SqlGuard`) runs on **every** SQL string before **every** execution
  (MongoDB: `MongoGuard`, on every generated pipeline).
- Every JDBC session is additionally forced read-only at the engine level
  (`ReadOnlySession`): defense in depth beyond the guard. MongoDB has no
  session/connection-level read-only flag to arm the same way, so for that
  engine `MongoGuard` is the only floor, not defense-in-depth alongside one
  (see its class doc).
- Only schema is ever sent to the configured AI model. On the SQL engines that means declared
  values only - a column's `ENUM` labels come from the DDL, not from anyone's rows. MongoDB has
  no DDL to declare them, so its introspector records a few distinct **values** per field while
  sampling, but they are stripped at the single exit from the catalog and never reach a prompt
  unless **Send sample column values to the model** is turned on in Settings. It defaults to off,
  so out of the box the model sees field names, types and presence percentages only. Full row
  data (arbitrary query results) is never sent on any engine.
- Chat history and query results are **in-memory only**, and secrets live only in the OS
  keychain via PasswordSafe. Apart from settings, the only things the plugin writes to disk
  are under the IDE's system directory and are ones you asked for: the JDBC driver jars it
  downloads on demand (`asksql/drivers`), the DuckDB database built when you load data files
  (`asksql/uploads`), the sample SQLite database (`asksql/sample`), and a CSV you export.
- Zero telemetry.

## Requirements

- JDK 21 (auto-provisioned by the Gradle toolchain via the foojay resolver if not
  already installed; no manual setup needed).
- Docker, only if you want to run the Testcontainers-backed integration tests
  (`./gradlew test -PintegrationTests=true`). Everything else (build, unit tests,
  `runIde`) needs no Docker.
- Node.js 20+ (the monorepo's `engines` floor; CI uses 22), only for
  `./gradlew parityVectors` (see below), which builds `@asksql/core` from this repo. Never required to build
  or run the plugin itself.

## Compatibility

AskSQL depends only on `com.intellij.modules.platform`, so it installs in **every
IntelliJ-Platform IDE, 2024.2 and newer** (build 242+), paid and
free editions alike. Fleet is not supported (it does not use the IntelliJ Platform plugin
model).

Every release is run through the JetBrains **Plugin Verifier**: 15 verifications across
11 IDEs, all reporting **Compatible** with zero compatibility problems:

| IDE | Versions verified |
| --- | --- |
| IntelliJ IDEA Community | 2024.2 (floor), 2024.3, 2025.1 (251.29188.72), 2025.2.6.2 (252.28539.54), 2025.3 (253.28294.334) |
| IntelliJ IDEA Ultimate, PyCharm Professional, WebStorm, PhpStorm, GoLand, Rider, CLion, RubyMine, RustRover | 2026.1.4 (latest stable) |
| Android Studio | whichever build is installed locally |

The IC entries from 2025.1 on are pinned by build number because ideaIC publishes both build-number
and marketing-version artifacts; the other IDEs publish marketing versions only.

`untilBuild` is deliberately open-ended (`null`), so the plugin stays installable on IntelliJ
majors that did not exist when it was published. The Plugin Verifier is the safety net: a
verification failure blocks the release.

2024.1 is out of reach: `com.intellij.util.net.JdkProxyProvider`, which routes model calls through
the IDE's proxy settings, arrives in 242.

IntelliJ IDEA Community is the version floor, so it is pinned at each supported major;
the other IDEs track the latest stable release. The plugin is compiled against the floor,
so an API the floor lacks fails the build rather than reaching the verifier.

DataGrip is not in the table above, but the plugin declares no dependency beyond
`com.intellij.modules.platform`, which DataGrip provides, so it installs and runs there on the
same APIs as every other IDE listed.

This is a **standalone Gradle project**: it is deliberately invisible to the root
pnpm workspace (no `package.json` anywhere under this directory tree; see
`.github/workflows/jetbrains-ci.yml`'s `isolation-guard` job, which fails the build if
that ever changes). Everything here is **pure Kotlin/JVM**: no Node.js runtime, no
child process, no sidecar. See `../../internal/JETBRAINS-PLUGIN-PLAN.md` (repo-internal)
for the full architecture rationale.

## Contributing

Everything below is for working on the plugin itself. See the repo's
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the monorepo layout and release process.

## Dev loop

```bash
./gradlew runIde          # launches a sandboxed IDE with the plugin installed
./gradlew test            # fast unit tests (guard, prompts, catalog pruning, ...)
./gradlew test -PintegrationTests=true # Testcontainers-backed tests (needs Docker)
./gradlew buildPlugin     # produces build/distributions/*.zip
./gradlew verifyPlugin    # IntelliJ Plugin Verifier against the configured IDE matrix
./gradlew koverVerify     # coverage floor; koverHtmlReport for the browsable report
```

## Parity tooling (`tools/parity/`)

The Kotlin SQL guard and prompt builders are ports of `@asksql/core` (the npm engine
used by the VS Code extension and `@asksql/server`), re-architected around JSqlParser
and JDBC instead of node-sql-parser and Node's DB drivers. To keep the Kotlin guard
from silently drifting from core's security behavior, `tools/parity/` runs a corpus of
SQL statements and questions through `@asksql/core` and records the verdicts as
committed JSON vectors (`vectors/guard.json`, `vectors/prompts.json`,
`vectors/classifiers.json`). `GuardVectorTest`, `PromptParityTest` and the classifier
tests replay those vectors against this Kotlin port in every `./gradlew test` run.

Which core the vectors come from is set by the `@asksql/core` pin in
`tools/parity/package.json`. It is `file:../../../core` between releases, so a change to
core's guard, prompts or routing must be ported to Kotlin and the vectors regenerated in
the same commit; CI fails on any uncommitted difference. The pin returns to a published
version after each release.

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

## Debugging the plugin

`./gradlew runIde` launches a sandboxed IDE attached to your run/debug configuration;
set breakpoints in this Kotlin code exactly as you would for any other JVM app; there
is no separate sidecar process to attach to.
