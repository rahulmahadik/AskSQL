# Changelog

All notable changes to the AskSQL JetBrains plugin are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Send sample column values to the model** in Settings. The setting existed and was
  wired up, but there was no way to switch it on. It stays off by default.

### Changed
- Installs on **2025.1 and newer**, down from 2025.2.
- A destructive request is recognised however it is phrased. "wipe the orders table",
  "purge old records", and the same with clear, erase, empty, flush or nuke come back
  as a statement to run yourself instead of being answered as a query. Recognition no
  longer depends on your tables being named like a shop.

### Fixed
- Oracle no longer fails outright on a `LIMIT` it cannot parse; the query is rewritten instead.
- A follow-up can refer to a query the answer suggested in prose. "Run that query" used to be
  answered as a new question, because only turns that produced SQL were remembered.
- Adding data files to a DuckDB connection that already has some keeps what is already
  there. The connection editor used to build a new database holding only the newly chosen
  files and point the connection at that, leaving the earlier ones behind. Adding to a
  connection you had already queried also failed outright, because AskSQL still held it open,
  and the new tables now appear in the schema tree without a manual refresh.
- A total is no longer inflated by a one-to-many join. Summing an order total while
  joined to its line items counted each order once per line, which reads as an
  ordinary figure and is silently wrong.

## [0.3.0] - 2026-08-01

### Added
- Off-topic questions ("tell me a joke") are declined in one line naming the
  connected engine, rather than erroring. General database questions - including
  "how would I do this in MongoDB?" - are answered for the engine you are on.
- MongoDB connections answer conceptual questions and write proposals too, in
  MongoDB vocabulary.

### Changed
- *Answer schema questions* is ON by default; it only ever replaces an error.
- When a query is blocked because the AI invented a table or column, the message now
  names the columns (or tables) that really exist, and says nothing was run - so you
  can rephrase instead of guessing.
- Answers stay honest under a hostile schema: the schema-answer prompt now states
  that catalog text (including column comments) is untrusted data, and a reply that
  is only a marker, a fragment, or a refusal is replaced by a plain explanation of
  what AskSQL can help with rather than being shown raw.
- **Refresh Schema** is reliable: a refresh pressed during a load no longer
  degrades into a cached redraw, a failed load no longer leaves the panel unable
  to refresh for the rest of the session, and the action works before the tool
  window has been opened. A refresh reports what it found in the status bar.
- Query results: the table fills the pane when narrow, every cell has a tooltip
  with its full value, column widths sample far more rows, and multi-line values
  no longer break row alignment.

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
- **Refresh Schema** on a connection's own menu refreshes that connection, not every one.
- The truncated-results banner no longer claims Export CSV returns the full result; it exports
  the rows shown, and says so.

## [0.2.0] - 2026-07-31

- **Test Provider** button in Settings: makes a real model call, so a wrong key,
  model id, or base URL fails there instead of mid-question.
- **Ask About This Table**: right-click any table in the schema tree to seed the
  chat with a question about it.
- **Write-query proposals**: asking for an INSERT/UPDATE/DELETE/DDL returns the
  statement as a proposal with an explicit read-only note - never executed.
  (Enable *Answer schema questions in plain language* to get proposals instead
  of a refusal.)

## [0.1.0] - 2026-07-25

First release. Chat and Schema tool windows, pure Kotlin/JVM engine (JSqlParser guard, JDBC
connectivity for Postgres/MySQL/SQLite/DuckDB/Oracle, MongoDB via a separate `MongoEnginePipeline`,
OpenAI-compatible/Anthropic/Gemini streaming clients incl. NVIDIA/Groq/local-model presets),
PasswordSafe-backed secrets, sample-database and DuckDB file-upload onboarding, connection editor
with per-engine validation and a Test Connection button, and "Explain"/"Suggest a fix" actions.

### Highlights
- Read-only by construction: an AST guard plus an enforced read-only DB session on every query
  (allowlist-based `MongoGuard` for MongoDB, which has no server-enforced equivalent).
- Zero telemetry; secrets only ever live in the OS keychain.
- CI parity-tested against the published `@asksql/core` guard/prompt behavior.
