# Changelog

All notable changes to the AskSQL VS Code extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-07-19

### Added

- The active AI provider and model are shown at the top of the **Databases** view; click it to change
  the model.
- A **Set up AskSQL** walkthrough (connect a database → choose a provider → ask) in Get Started, and the
  sidebar welcome now links AI setup too.

### Changed

- Setup errors in the chat (no model selected, no API key, provider unreachable) now show a one-click
  fix button — Set up provider / Set API key / Choose model — instead of only telling you which command
  to run.
- **Set AI Provider API Key** now asks which provider the key is for, so a key can no longer land in the
  wrong provider's slot; it also no longer clears the stored key if you cancel.
- A rejected API key while listing models now says the key was not accepted (401) and offers to
  re-enter it, instead of a bare "endpoint replied 401".

### Fixed

- "Ollama is not running" and similar connection errors now show their friendly, actionable message
  even when the underlying error is wrapped.

## [0.2.0] - 2026-07-19

### Added

- NVIDIA as a built-in AI provider (OpenAI-compatible, with a free tier). Select it from
  **AskSQL: Select AI Provider** like any other provider.
- Guided provider setup: choosing a provider now prompts for its API key (stored in the OS
  keychain) and, for providers that publish a model list, lets you pick the model instead of typing
  its id. Official API endpoints are pre-filled per provider, so `asksql.baseURL` is only needed to
  point at a custom endpoint.

### Fixed

- A wrong or unavailable model id now reports a clear "model not found - check the id" message
  instead of looking like a temporary outage.
- Setup guidance and menu labels now point at commands that exist (**AskSQL: Select AI Provider** /
  **Choose Answering Model**).

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
