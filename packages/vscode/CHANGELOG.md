# Changelog

## 0.1.1

### Patch Changes

- Updated dependencies
  - @asksql/core@0.2.0
  - @asksql/mysql@0.2.0
  - @asksql/postgres@0.2.0
  - @asksql/sqlite@0.2.0

All notable changes to the AskSQL VS Code extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First release.

### Added

- **The AskSQL panel** - a dedicated sidebar view. Ask a database question in plain language, see
  the generated SQL with a short explanation, and get the results as a table. Themed from VS Code's
  own variables, so it matches any theme in light and dark.
- **Read-only by design** - a deterministic AST guard refuses writes, DDL, and stacked statements
  before the database ever sees them.
- **Schema explorer** - connections, tables, views, and columns with keys, read straight from the
  database, so it works before any AI provider is set up.
- **Bring your own model** - a VS Code chat model (via the Language Model API) if you have one, or
  your own provider: Ollama (offline, no key), OpenAI, Anthropic, Google, Groq, or any
  OpenAI-compatible endpoint. Models are discovered from your endpoint, not a baked-in list.
- **Databases** - PostgreSQL, MySQL / MariaDB, and SQLite, with no native modules to compile.
- **Guided connection setup** - saves to your user or workspace settings (your choice) and keeps
  the password in the OS keychain, never in a settings file.
- **Result actions** - Copy (with headers), Open results in editor, Export CSV, Open SQL in editor,
  and Explain plan from the database's own EXPLAIN.
- **Structure questions** ("describe the customers table") answered instantly from the schema, with
  no model call.
- Database passwords and provider API keys are stored in the OS keychain.
