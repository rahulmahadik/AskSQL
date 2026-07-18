# Changelog

All notable changes to the AskSQL VS Code extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-17

First release.

### Added

- Ask a database questions in plain language from a sidebar chat. Every answer shows the exact SQL
  it ran, with a short explanation.
- Read-only by design: a deterministic guard - not the prompt - decides what runs. Writes, DDL and
  stacked statements are refused before the database sees them.
- PostgreSQL, MySQL / MariaDB and SQLite, local or cloud. Connect with host and port plus an
  SSL/TLS mode (verify or do not verify), or paste a connection string.
- Passwords, connection strings and API keys are stored in your OS keychain, never in settings.
  **AskSQL: Remove All Connections and Keys** clears them.
- Bring your own model: a chat model already in VS Code (no API key), a local Ollama model, or your
  own OpenAI / Anthropic / Google / Groq key.
- Schema explorer for tables, views, columns and keys, plus "describe the X table" answered
  instantly from the schema with no query and no model call.
- Results inline with one click to copy (with headers), open the full result set or the SQL in an
  editor, or ask the database for its query plan.
- Optional `asksql.sampleColumnValues`: show the model the handful of codes a short text column
  holds, so it filters on values that exist. Off by default - it is the one setting that sends
  column values, not just schema, to the model.
