# Changelog - AskSQL for Edge and Chrome

All notable changes to the browser extension. Versions match `manifest.json`.

## 0.2.1 - 2026-08-07

### Fixed
- A crafted zip could exhaust the tab. The size and compression-ratio guards read the sizes the
  archive declared, so an entry claiming 1KB and inflating to gigabytes passed every check and was
  fully decompressed before it could be rejected.
- The model picker no longer offers embedding, reranking or document-parsing models, which answer
  404 to a chat request.

### Changed
- The side panel starts on 0.26MB of JavaScript instead of 4.18MB. The SQL guard's parser is the
  bulk of it and is fetched only when a data-file connection is opened.

## 0.2.0 - tagged 2026-08-06, awaiting store review

### Added

- **Azure OpenAI** as a provider. Set the base URL to your resource endpoint
  (`https://<resource>.openai.azure.com`), and use your deployment name as the model.
- **Refresh schema** in the side panel. A table or column added elsewhere was invisible until the
  connection was disconnected and remade; the button re-reads it in place and says how many tables
  came back. For a server-backed connection this asks the sidecar for a fresh read, not its cache.

### Fixed

- The **row cap** now applies to server-backed connections. It was sent only to the in-browser
  engine, so for a sidecar the setting silently did nothing and the server's own cap applied.
- **Schema budget** and **Custom instructions** say that they apply to data file connections. Both
  shape a prompt, and a sidecar builds its own prompts, so they never reached it - the settings
  page presented them as global anyway.
- **Reset everything** no longer says it clears saved queries. This extension has none.

## 0.1.0 - first store submission

First release. AskSQL as a browser side panel: ask a database questions in plain
English, read-only, schema-only prompts, zero telemetry.

### Connections

- Add connections in Settings and pick one from a dropdown in the side panel,
  the same shape the AskSQL JetBrains plugin uses.
- **Data file connections**: CSV, TSV, JSON, NDJSON, Parquet, Excel, `.sql`
  dumps, or a `.zip` of any mix, loaded into their own DuckDB-WASM database and
  queried entirely in the browser. Several files in one connection can be joined;
  a multi-sheet workbook becomes one table per sheet. Unsupported zip members are
  skipped and named, never silently dropped.
- **Database connections**: PostgreSQL, MySQL, Oracle, MongoDB, SQLite, DuckDB,
  entered with engine/host/port/database/user/password and per-engine defaults
  (5432/`postgres`, 3306/`root`, 1521/`system`, …). A browser extension cannot
  open a database socket, so the details are sent to an AskSQL server you run;
  this browser stores only that server's address and the id it returns, never
  the password.
- **AskSQL server connections**: point at a server and use every database it
  already exposes. **Test** lists them with their engine and database name.
- Connections persist, so closing the panel never means re-uploading. Switching
  connection mid-chat starts a fresh transcript, so one database's context can
  never leak into questions asked of another.

### Chat

- Model and provider shown in the header; click it to change them.
- **Schema** panel listing the connection's tables and views; picking a table seeds a question.
- Ask about any page selection via the right-click menu.
- Approval-before-run (optional) and a row cap.

### AI providers

- Ollama, Groq, NVIDIA, OpenAI, Anthropic, Google, Azure, and any
  OpenAI-compatible endpoint.
- **Fetch models** lists what your endpoint actually has, instead of guessing an id.
- **Test provider** makes a real call, so a wrong key or model fails here rather
  than mid-question.
- Works with a local Ollama with no `OLLAMA_ORIGINS` configuration: AskSQL removes
  the `Origin` header Ollama rejects, for your configured provider only
  (see PRIVACY.md).

### Privacy and safety

- No analytics, no telemetry, no AskSQL server. Only your chosen AI provider and
  your own sidecar are ever contacted.
- The model receives your schema and question, never row data or results.
- Read-only enforced by an AST guard on every query, plus a read-only session at
  the driver level where the engine supports it.
- Site access is requested per-origin when you first use it, never upfront.
- **Reset settings to defaults** keeps your connections; **Reset everything**
  clears them and their data too.

### Known limitations

- Edge's side panel reloads on tab switch
  (microsoft/MicrosoftEdge-Extensions#222). Uploaded data is kept in an
  OPFS-backed database so a reload doesn't lose it; verified in Chrome, not yet
  against a real Edge install.
- Database connections need an AskSQL server started with dynamic connections
  enabled (`npx --package=@asksql/server asksql serve --provider ollama --model <id>`,
  plus that engine's connector packages - see the server README).
