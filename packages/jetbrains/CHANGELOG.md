# Changelog

All notable changes to the AskSQL JetBrains plugin are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.0] - 2026-08-20

### Added
- The schema now states what a column's type cannot: the unit of an integer timestamp, and the shape of
  a JSON column. Comparing epoch milliseconds against epoch seconds matches every row and raises no
  error, and a guessed JSON key matches none, so both produced confident wrong answers. Supported on
  SQLite, PostgreSQL, MySQL, DuckDB and Oracle.
- A filter comparing a column against a value it does not hold is reported, rather than answering zero
  as though nothing matched the question.

### Fixed
- Fetch Models reports the provider's own error instead of coming back empty, so a rejected key, a rate
  limit and an outage are no longer indistinguishable.
- Models that cannot answer a question are no longer listed.
- Output from reasoning models no longer appears in answers or explanations.
- Switching from a local provider to a hosted one no longer leaves the old base URL in place, which sent
  requests to this machine and reported success without a key. An existing setting is corrected on open.
- Settings now ask for the API key before the model, so Fetch Models has what it needs; Test Provider is
  renamed Test Connection and runs after a model is chosen.
- The "send sample column values" description now covers every path it gates.

## [0.5.4] - 2026-08-18

Android Studio is where this plugin is mostly installed, and an Android app's database is SQLite via
Room. Every fixture the test suite owned used real types, so none of this was covered until a
Room-shaped database was tried.

### Fixed
- A query over a table with a `ByteArray` column returned nothing at all. SQLite's driver reports those
  cells as BLOB and implements none of the streaming interface, so reading them threw and the whole
  result set was lost, reported as "the database didn't accept that query".
- `SELECT rowid FROM users` was refused as an invented column. SQLite gives every table `rowid`, `oid`
  and `_rowid_` without listing them, and FTS tables answer to `docid` and `rank`.
- Opening a file that is not a readable database - encrypted, truncated, or the `-wal` sidecar picked by
  mistake - reopened it about 21,000 times a second until the operation timed out, pegging a core and
  then reporting something unrelated. It now fails once, saying that a database pulled from a device
  needs its `-wal` and `-shm` files alongside it.
- A date comparison against an integer timestamp answered confidently and wrongly: Room stores epoch
  milliseconds, and comparing that with a text date matches nothing while comparing it with epoch
  seconds matches everything. Neither raised an error. The guidance now states the units, and a check
  catches the comparison and sends it back to be corrected.
- Full-text search ran at all. A Room `@Fts4` entity is queried with `MATCH`, which the SQL parser has
  no notion of, so every full-text query was refused as unparseable. Writes, stacked statements and
  denied functions are still refused.
- A relationship question about two collections is answered in prose on MongoDB, as it already was on
  the SQL engines, rather than returning documents.

## [0.5.3] - 2026-08-15

### Security
- A result cell, a schema tree label and a chart tooltip are rendered as text, never as markup. Swing
  reads a string beginning with `<html>` as HTML, so a value like `<html><img src=http://...>` in a
  database the plugin displayed would fetch that URL from inside the IDE.
- Database error text is redacted before it reaches the model. A driver quotes the offending row, so
  the "suggest a fix" prompt carried cell values that were never meant to leave the machine.

### Added
- Structure questions are answered with SQL written by the plugin rather than guessed by the model:
  row counts per table, tables without a primary key, and what the database contains.
- A relationship question is answered from the foreign keys instead of returning rows of a join.
- On Oracle, an account that only holds grants on another schema is told which schemas it can read,
  rather than being shown an empty database.

### Fixed
- A whole number is shown without a decimal the database never had. An INTEGER column and every
  MongoDB integer rendered as `1.0` in the result grid, the copy buffer and exported CSV.
- An INTEGER sorts and charts as a number rather than as text, matching the other surfaces.
- A SUM across a one-to-many join reports that the total is inflated by the join, instead of
  presenting the multiplied figure as the answer.
- On Oracle, a query the model wrote with `LIMIT` was refused and every correction attempt failed the
  same way. A plain trailing `LIMIT n` is now read as `FETCH FIRST n ROWS ONLY`.
- A failed schema read is no longer cached as an empty database for five minutes, so fixing the
  permission and asking again works immediately.
- A transient rate limit from a provider is reported as a rate limit rather than as a billing
  problem, which told the user to check a payment method that was fine.
- A mid-stream error from an OpenAI-compatible provider is surfaced instead of being swallowed and
  returned as a truncated answer.
- The follow-up context is updated on the UI thread, and a finished question can no longer clear the
  busy state of one that is still running.

## [0.5.2] - 2026-08-14

### Fixed
- A mixed-case Postgres schema failed every query. An unquoted name folds to lower case and resolves
  to nothing; Oracle folds the other way, and MySQL on Linux compares table names case-sensitively.
  Table and column names are now quoted from the catalog before the query is validated, and correct
  names are left untouched.
- Reserved words now come from each database itself rather than one shared list that applied MySQL's
  rules to Postgres and missed most of MySQL's own.
- Quoting knows where a word is syntax rather than a name, so `CAST(x AS DATE)` and
  `EXTRACT(MONTH FROM d)` are left alone.
- A table named like a parser keyword, such as `order` or `Nulls`, could not be parsed in its bare
  form, so the question failed after three attempts.
- An apostrophe inside a value, as in `'O'Brien'`, produced only "could not parse", so the model
  returned the same statement until it ran out of attempts. It is now told to double the quote.
- Questions about structure no longer invent a database name. Without being told which database it
  is connected to, the model wrote `table_schema = 'your_database_name'` and returned nothing, which
  reads as an empty database rather than an error.
- `AVG(SUM(x))` is repaired instead of run. Nested aggregates are invalid in every engine.
- Per-table row counts work again. A `UNION ALL` across tables was blocked as a hallucinated column,
  because each branch's columns were judged against every branch's tables.

## [0.5.1] - 2026-08-12

### Fixed
- A question asking what to change or improve is answered in prose again. The classifier matched
  "best practices" but not a misspelling of it, and not "what changes are needed", so a question
  phrased either way fell through to SQL generation and ran a table listing instead.
- Deleting a connection ends its conversation. The transcript was only discarded when moving between
  two connections, so removing one and adding another brought the old chat and its follow-up context
  onto a different database.
- **Explain** retires once the answer is on screen. It stayed clickable, and each further click paid
  for the same description again. A failed attempt still leaves it available to retry.
- A question from the schema tree runs against the connection you right-clicked, rather than whichever
  one the chat had selected.

### Added
- **Describe This Database** on a connection's right-click menu: what the database is for, how the
  tables relate, and how many there are, answered from the whole schema.

## [0.5.0] - 2026-08-09

### Fixed
- A two-line answer is no longer clipped to one, with the note below it painting over the rest. The
  text pane reported its height measured at its unwrapped width rather than the width it was given.
- The **Explain** button comes back after a failure. It disabled itself on click and, if the model
  call failed, stayed disabled for the rest of that turn.
- A MongoDB turn no longer says "Writing SQL" or "Finding relevant tables" while it builds a pipeline.
- Content appended to a turn already on screen is scrolled into view, so an approval bar below the
  fold is reachable. Scrolling only follows when you are already at the bottom, so it will not pull
  you away from an earlier turn you are reading.
- A backticked placeholder such as `?`, a date, or `:param` is no longer reported as a name missing
  from your schema.
- A proposed write showed three separate lines saying nothing had run. It shows one.
- The copy control reports failure instead of showing a tick when the clipboard write is refused.

### Added
- **A copy control on every answer**, not only on result grids: explanations, schema answers, and
  errors each copy the model's own text rather than the rendered markup.
- **A query inside a prose answer renders as a real code block** with syntax highlighting and its own
  Copy, instead of running together with the sentences around it.
- **The transcript reads as a conversation.** Your question sits on the right in a tinted bubble,
  AskSQL answers on the left, and a rule separates one turn from the next.
- Progress is shown for the states that used to sit blank: preparing a turn, answering from the
  schema, and correcting a query the database rejected.
- A MongoDB pipeline's collection name is selectable and travels with Copy, as a
  `db.getCollection(...).aggregate(...)` call that pastes straight into mongosh.
- Progress is announced to screen readers where the IDE runtime supports it.

### Changed
- Connections are released when the project's services are disposed rather than through an
  experimental platform listener, so cleanup also covers disabling or unloading the plugin. The
  listener also woke both connection registries on every project close, including in projects where
  AskSQL was never opened.
- The guard detects `LIMIT ALL` through JSqlParser's supported API. The two methods it used before
  are deprecated, and the guard failing to compile on a future parser release is not a small problem.

## [0.4.2] - 2026-08-09

### Fixed
- **Your connections and settings survive closing the IDE.** Every field in the plugin's saved state
  was declared in a way IntelliJ's serializer silently drops, so connections, provider, model, base
  URL, row caps, custom instructions and the glossary were all written as empty and came back empty
  on the next start. Nothing warned; the settings simply reverted every time.
- **"Require explicit approval before running generated SQL" stays on.** It was part of the same
  state, so a user who switched it on lost the approval step at the next restart without being told.

## [0.4.1] - 2026-08-06

### Fixed
- A result with one or two rows is visible again. The horizontal scrollbar appeared inside the
  height the chat had already allotted, so with a single row it covered the only row there was.

### Changed
- Installs on **2024.2 and newer**, down from 2025.1. The only thing that had ever stopped it was
  one constructor: 2025.1 added a single-extension `FileSaverDescriptor`, and binding to it emitted
  a call older IDEs do not have, so CSV export would have thrown at runtime. 2024.1 stays out of
  reach, because the API that routes model calls through the IDE's proxy settings arrives in 2024.2.

## [0.4.0] - 2026-08-06

### Added
- **A business glossary** in Settings. Give your own terms a meaning once ("active
  customer", "GMV", which table counts as revenue) and every answer uses them.
- **Send sample column values to the model** in Settings. The setting existed and was
  wired up, but there was no way to switch it on. It stays off by default.
- When an answer proposes a query rather than running one, the query now appears as a
  SQL block with a copy button, formatted as JSON for MongoDB pipelines. There is no
  run button: a proposal is often a write, and the plugin executes none.
- **A chart above the result** when the shape suits one. A label column and a numeric
  column draw a bar chart; a date label draws a line. Anything else stays a table, and
  the table always holds every column.

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
