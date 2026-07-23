# FAQ

### Does my data go to the AI provider?

No. The model receives your **schema** (table and column names, types, relationships, enum
values, and a row-count estimate) plus the question. It never sees your rows. The generated
SQL runs against your database, and the results come back from there, not from the model.

### Do I need a backend?

Not for browser file analytics: with `@asksql/duckdb/browser`, CSV / JSON / Parquet / Excel
are parsed and queried entirely in the tab, and the model is called from the client. For a
real database (Postgres / MySQL / SQLite / Oracle / MongoDB) you run the `@asksql/server`
sidecar so credentials and the guard stay server-side; the browser only talks HTTP to it.

### Which databases are supported?

PostgreSQL, MySQL / MariaDB, SQLite, DuckDB, Oracle, and MongoDB. Each has its own adapter
package and its own driver as a peer dependency. See the Databases section of the README.

### I work in Excel / CSV spreadsheets all day - can AskSQL help?

Yes - this is one of the best fits. With `@asksql/duckdb` you can point AskSQL straight at
CSV, JSON, Parquet, and Excel (`.xlsx`) files and ask questions in plain language instead of
writing formulas or pivot tables. In the browser build nothing leaves your machine - the file is
parsed and queried right in the tab. A few things worth knowing:

- **Multiple files**: register several files and each becomes its own table, so you can **join
  across files** (for example a `customers.csv` joined to an `orders.csv`).
- **Multiple sheets**: an Excel workbook's sheets are separate tables. Register the same file
  once per sheet with a `sheet` name and a distinct `table`, then **join across sheets** (for
  example a `Sales` sheet against a `Targets` sheet). By default the first sheet is used.
- **Big files**: Parquet and large CSVs are handled by DuckDB's columnar engine, so this scales
  well past what a spreadsheet app is comfortable with.

```ts
new DuckDbConnector({ id: 'book', name: 'Workbook', files: [
  { table: 'sales',   path: 'plan.xlsx', format: 'xlsx', sheet: 'Sales' },
  { table: 'targets', path: 'plan.xlsx', format: 'xlsx', sheet: 'Targets' },
] });
// then ask: "which regions beat their target?" - it joins the two sheets for you
```

### What file types and sizes can it handle?

Five formats: **CSV**, **JSON**, **NDJSON**, **Parquet**, and **Excel** (`.xlsx` / `.xls`). The
format is inferred from the extension, or you can set `format` explicitly. You can register as
many files as you like - there is no file-count limit, and each becomes its own joinable table.

There is **no fixed size cap** in AskSQL itself. In the browser the file is streamed into
DuckDB-WASM (bounded by the tab's available memory, or persistent OPFS storage if enabled), and
DuckDB's columnar engine handles Parquet and large CSVs far past what a spreadsheet app manages
comfortably. The server sidecar's `maxBodyBytes` limit (default 64 KB) applies only to API
request bodies - questions and SQL - not to files, which the browser reads locally and never
uploads. If a file is corrupt or its contents do not match its extension (say a renamed image),
you get a clear `FILE_PARSE` error naming the file, not a crash.

### Which LLM providers work?

OpenAI, Anthropic, Google Gemini, Azure (classic and AI Foundry), Groq, NVIDIA, Ollama (fully
local), and any OpenAI-compatible endpoint (OpenRouter, Together, DeepSeek, xAI, LM Studio,
vLLM, and more). See [docs/providers.md](providers.md) for per-provider config.

### Is there a free option?

Yes, two: **Ollama** runs a model fully on your machine with no key, and **Groq** has a free
API tier. Both are verified working. OpenAI, Anthropic, and Google all require a funded
account (no usable free API tier in most regions).

### Can the AI run a write or a destructive query?

No. A deterministic, AST-based guard - not the prompt - decides what runs. It allows a single
read-only `SELECT` (CTEs included) and blocks every write, DDL, stacked statement, locking
clause, file-reading function, and a per-dialect dangerous-function denylist. Anything it
cannot parse fails closed. Where the engine supports it (Postgres, MySQL, SQLite, Oracle) the
connector also opens a read-only session as a backstop; DuckDB has no read-only session, so the
AST guard is the sole barrier there.

### Can I ask general questions about the schema - or how to change it?

Yes, if you turn on **Answer schema questions** (off by default, in the extension/plugin settings).
With it on, a question that isn't a data query - "summarize this database", "how are customers and
orders related?", or even "how would I add an index on email?" / "what column tracks loyalty points?"
- is answered in plain language from the schema instead of erroring.

Two guarantees hold. It is **grounded**: it only names tables, columns, and relationships that exist;
any name it can't find is flagged, and an ungrounded answer is regenerated once. And it stays
**read-only**: schema-change advice is shown as DDL you run yourself, marked as a proposal - AskSQL
never writes to the database (the guard blocks every DDL statement regardless). Accuracy depends on
your model, so treat the text as guidance.

### Do results require human approval?

By default no: the generated SQL and its explanation are always shown, but the query runs
automatically so people get results in one step. Because the guard has already proven the SQL
is read-only, there is nothing to mutate. If you want a person to sign off on every query,
set `requireApproval` (on `<AskSqlChat>` / `<AskSqlBubble>`, the widget's `AskSQL.mount`, or
the `useAskSql` hook) and each turn waits behind a Run button.

### Can I customize or replace the UI?

Yes, at four levels: CSS-variable theming, component props, composing the exported building
blocks (`ResultTable`, `SqlBlock`, `SchemaBrowser`, `ResultChart`), or the fully headless
`useAskSql` hook. See the "Customizing the UI" section of the README.

### Can agents use AskSQL?

Yes. `@asksql/mcp` exposes the engine as Model Context Protocol tools, so an MCP host (Claude
Desktop, IDE agents) can list connections, read the schema, generate SQL, and run approved
read-only queries. The guard applies to agent calls too - a write is blocked.

### Does it work on Windows / in every browser?

Yes. It runs on macOS, Linux, and Windows, and the browser connector uses only standard Web
Worker / OPFS / File APIs.

### How are errors surfaced?

Every failure maps to a stable code with a plain-language message: `LLM_AUTH` (bad key),
`LLM_BILLING` (out of credits / over quota, not retried), `LLM_RATE_LIMIT` (transient, retried
with backoff), `GUARD_BLOCKED` (unsafe SQL), and so on. Only the code, message, and a
retryable hint are returned on the wire - never a prompt, schema, or raw provider response.

### How accurate is the generated SQL?

The guard guarantees the SQL is **safe** (read-only) and shows it to you before it runs; it
does not guarantee the query is **semantically** what you meant. Accuracy tracks two things:
how capable your model is, and how complex the question is. Simple filters and joins are
reliable; heavy multi-table analytics can trip a smaller model into a join fan-out (an inflated
`SUM`) or a hallucinated column. AskSQL has a **hallucination floor** that helps here: before a
query runs it checks every table and column against your schema, and if the model invented or
mis-guessed a column it is handed the real column list and re-asked - so many column mistakes
are fixed automatically before the database sees the query. It does not catch a semantically
wrong-but-valid query (like a fan-out), so always review the SQL, and give hard analytics a more
capable model. See "Accuracy depends on the model and the question" in the README.

### Which local model should I use?

A coder-tuned model is what you want. In our testing against a real database, a **7B**
(`qwen2.5-coder:7b`) was the sweet spot - it matched a 14B on accuracy while running about twice
as fast, and it is a comfortable size to run locally. Rough guidance:

- **7B** (for example `qwen2.5-coder:7b`) - the recommended default: good on multi-join
  analytics, light enough for most machines.
- **14B** (`qwen2.5-coder:14b`) - a bit more headroom on the hardest questions, at higher memory
  and latency.
- **1.5B-3B** - fast and fine for simple, single-table or small-schema questions, but it slips
  on complex joins or large, messily-named schemas, so use it only for lightweight cases.

You can point AskSQL at any Ollama, MLX, or OpenAI-compatible local runtime, and any coder model
in that size range works. One thing that helps every size: a schema with **consistent, clear
column names** (a plain `service_id`, not `id`; `is_canceled`, not `canceled`) - ambiguous names
are where even a 14B occasionally guesses a wrong column.

### Can it run fully offline, with nothing leaving my machine?

Yes. Run a local model through Ollama (or any OpenAI-compatible local server like LM Studio or
vLLM) and keep the database local. Only the schema and question ever reach the model, and with
a local model that never leaves your machine at all. `allowDataInPrompt` (opt-in, off by
default) is the only setting that would include sampled cell values, and only in repair prompts.

### Does it handle large schemas with many tables?

Yes. The engine introspects the whole schema, then prunes to the most relevant tables under a
token budget before prompting, so a database with dozens of tables still fits the model's
context. It also infers joins from naming conventions when foreign keys are not declared (common
in MySQL apps).

### Can I query more than one database at once?

Yes. Register multiple connectors on one engine and the UI shows a **connection dropdown** to
pick between them. They can be:

- **The same database** exposed as separate connections (for example a "Shop DB" and a
  "Reporting DB" pointing at the same Postgres) - handy for labelling different intents or
  schemas.
- **Different databases, even different engines** - a Postgres, a MySQL, and a DuckDB
  file-analytics connection side by side, all in the same dropdown (each row shows its name and
  engine).

Connections are configured by you, the integrator, in the `connectors` array (and the server
sidecar's auth hook decides which connections each user is allowed to see via
`allowedConnectionIds`). End users **pick** from that list - they never enter database
credentials in the browser, which stay server-side.

Each question runs against the **one** selected connection; a single SQL query cannot join two
separate database connections (they are different servers). The exception is file mode: within
one DuckDB connector, every registered file or Excel sheet is a table, so you can join freely
across them.

### Can I enforce my own SQL house style?

Yes, without forking. `config.prompts.instructions` appends house rules (for example "prefer
CTEs", "alias every aggregate") to the built-in prompt, and `config.prompts.system` replaces it
entirely. The guard still enforces read-only regardless of what any prompt says.

### Is it production-ready?

It is an early (pre-1.0; `@asksql/core` is at `0.3.x`) but functional release: the pipeline
(schema to SQL to guard to execute), the safety guard, the six database adapters, the server
sidecar, the React UI, and the MCP server are all working and tested against live databases
and multiple providers. Treat
generated SQL for complex analytics as reviewable draft, keep credentials on the server sidecar,
and pin the versions you deploy.
