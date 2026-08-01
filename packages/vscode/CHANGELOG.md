# Changelog

All notable changes to the AskSQL VS Code extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-01

### Added
- **Off-topic questions get an honest answer**: a question with nothing to do
  with data ("tell me a joke") is declined in one line naming the connected
  engine, instead of an error. Questions about databases in general - modelling,
  indexing, or how another engine would do it - are answered normally.
- **MongoDB schema answers**: conceptual questions and write proposals now work
  on MongoDB connections, in MongoDB vocabulary (collections, `$lookup`), not
  just on SQL ones.

### Changed
- *Answer schema questions* is now ON by default. It only ever replaces an
  error, and it is what turns a write request into a reviewable proposal.
- When a query is blocked because the AI invented a table or column, the message now
  names the columns (or tables) that really exist, and says nothing was run - so you
  can rephrase instead of guessing.
- Answers stay honest under a hostile schema: the schema-answer prompt now states
  that catalog text (including column comments) is untrusted data, and a reply that
  is only a marker, a fragment, or a refusal is replaced by a plain explanation of
  what AskSQL can help with rather than being shown raw.
- **Refresh Schema** now always re-reads the database. A refresh pressed while
  the tree was still loading could return the table list from before the
  refresh, and a slow read could write that stale list back afterwards; both are
  fixed, so a table created outside the IDE appears on the first refresh.
- **Test Connection** no longer reports the table count from a read that started
  before the test.

### Fixed
- A query using more than one CTE (`WITH a AS (...), b AS (...)`) is no longer
  refused as though the later CTE names were invented tables.
- Answers in Chinese, Japanese, Korean, Russian and Greek are no longer discarded
  as "not an explanation" - the check assumed spaces between words and Latin letters.
- An answer that merely uses the English phrase "out of scope" is kept instead of
  being mistaken for the internal marker and replaced by a decline.
- A refusal written with a typographic apostrophe ("I'm sorry") is recognised as a
  refusal rather than being shown as if it were an answer.
- Schema answers no longer flag a CTE the answer itself defines as an invented name.
- A change request phrased in the third person - "a command that deletes cancelled
  orders", "a query that removes old rows" - is recognised as a change and answered with
  a proposal, instead of being declined as though it were not about databases.
- A question is treated as being about your database whenever it names a real table,
  view or column - so imperfect phrasing or grammar no longer gets a request refused.
- The **NVIDIA** API key is now deleted by *Remove All Connections and Keys*; it was the one
  provider the reset missed, so a key survived in the keychain.
- **Refresh Schema** on a single connection refreshes that connection, not every one of them.
- The truncated-results notice no longer claims an export returns the full result - it says
  these are the first rows and how to see more.

## [0.4.0] - 2026-07-31

### Added
- **Ask About This Table**: an inline action on every table in the schema view
  that focuses the chat prefilled with a question about that table.
- **Write-query proposals**: asking for an INSERT/UPDATE/DELETE/DDL now returns
  the statement as a text proposal carrying an explicit read-only note - never
  executed. (Enable *Answer schema questions* to get proposals instead of a
  refusal.)

### Changed
- A provider 403 no longer claims the API key was rejected when it may be a
  local model server refusing the request's origin; the message now covers both.

## [0.3.1] - 2026-07-24

### Fixed

- Fenced ` ```sql ` code blocks in schema answers and explanations now render as code blocks instead of literal backticks.

## [0.3.0] - 2026-07-24

### Added

- Oracle and MongoDB connections.

### Fixed

- Reliability: query timeouts, connection-pool recovery, and read-only enforcement hardened across all engines.

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
