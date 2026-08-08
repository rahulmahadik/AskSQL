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

Six formats: **CSV**, **JSON**, **NDJSON**, **Parquet**, **Excel** (`.xlsx` / `.xls`), and a
portable **`.sql`** dump (its CREATE TABLE + INSERT statements are run and the tables they build
become queryable). The format is inferred from the extension, or you can set `format` explicitly.
You can register as many files as you like - there is no file-count limit, and each becomes its
own joinable table.

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
read-only `SELECT` (CTEs included), `EXPLAIN` of one, and read-only `PRAGMA` / `SHOW`, and blocks
every write, DDL, stacked statement, locking clause, file-reading function, and a
dangerous-function denylist. Anything it cannot parse fails closed. Where the engine supports it
(Postgres, MySQL, SQLite, Oracle) the connector also opens a read-only session as a backstop.
DuckDB has no read-only session: in Node a plain database file is opened `READ_ONLY`, but
registering `files` needs `CREATE VIEW`, so in that mode and in the browser the AST guard is the
sole barrier.

### Can I ask general questions about the schema - or how to change it?

Yes. **Answer schema questions** is on by default in the VS Code extension, the JetBrains plugin
and the browser extension. In code it is the `answerSchemaQuestions` option on `useAskSql` /
`<AskSqlChat>`, where it is **off** by default; `engine.explainSchema(question)` is always
available directly. A question that isn't a data query - "summarize this database", "how are
customers and orders related?", or even "how would I add an index on email?" / "what column tracks
loyalty points?" - is answered in plain language from the schema instead of erroring. A bare
imperative write ("delete all cancelled orders") is routed here too, before any model call, so it
returns a proposal instead of a SELECT. This works on MongoDB connections too, in MongoDB terms
(collections, `$lookup`).

Ask something with nothing to do with data and AskSQL says so in one line rather than guessing;
general database questions - modelling, indexing, or how another engine would express something -
are answered for the engine you are connected to.

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
`useAskSql` hook. See "Customizing the UI" in the
[`@asksql/react` README](../packages/react/README.md).

### Can agents use AskSQL?

Yes. `@asksql/mcp` exposes the engine as Model Context Protocol tools, so an MCP host (Claude
Desktop, IDE agents) can list connections, read the schema, generate SQL, and run approved
read-only queries. Five tools: `asksql_list_connections`, `asksql_schema`, `asksql_query`,
`asksql_explain_schema`, `asksql_run`. The guard applies to agent calls too - a write is blocked.
It wraps a `createAskSql` engine, so it covers the five SQL engines, not MongoDB.

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
are fixed automatically before the database sees the query.

A join fan-out is caught too: if a query sums a column from a table while joined to another table
that has many rows per row of the first, each value would be counted once per child row and the
total would come back too high. AskSQL spots that from your foreign keys and re-asks. Other
semantic mistakes still get through, so always review the SQL, and give hard analytics a more
capable model. The section [below](#accuracy-depends-on-the-model-and-the-question) goes deeper,
with measured numbers.

### The numbers look wrong by a factor of 100. Why?

Almost always a unit the schema names but never explains. A column called `total_cents` holds
cents, so "total revenue in dollars" can come back as `1000000249999` rather than
`10000002499.99`, and it reads as an ordinary figure.

Nothing about the column's type says which unit it is, so tell it once and every question after
that gets it right. Either comment the column in your database:

```sql
COMMENT ON COLUMN orders.total_cents IS 'Order total in cents; divide by 100 for dollars';
```

or define the term in the glossary, which needs no schema change:

```ts
createAskSql({
  connectors,
  model,
  glossary: [{ term: 'revenue in dollars', definition: 'sum of orders.total_cents divided by 100' }],
});
```

Comments already travel into the prompt with the rest of the schema, so either one works, in any
language and for any unit (milliseconds, bytes, basis points). On our own fixture a 7B went from
getting this wrong every time to right every time on the strength of that one comment.

### Which local model should I use?

A coder-tuned model is what you want. Use **`qwen2.5-coder:7b`** unless you have a reason not
to. Across PostgreSQL, MySQL and MongoDB questions on a real database, a 7B answered every one
correctly - the same as a 14B - at roughly half the latency (median ~3s against ~6s), and it is
a comfortable size to run locally. Rough guidance:

- **7B** (for example `qwen2.5-coder:7b`) - the recommended default: good on multi-join
  analytics, light enough for most machines.
- **14B** (`qwen2.5-coder:14b`) - a bit more headroom on the hardest questions, at higher memory
  and latency.
- **1.5B-3B** - fast and fine for simple, single-table or small-schema questions, but it slips
  on complex joins or large, messily-named schemas, so use it only for lightweight cases. It
  invents column names more often; AskSQL blocks those before the database sees them and tells
  you which columns the table really has, so the failure is safe rather than silent.

You can point AskSQL at any Ollama, MLX, or OpenAI-compatible local runtime, and any coder model
in that size range works. One thing that helps every size: a schema with **consistent, clear
column names** (a plain `service_id`, not `id`; `is_canceled`, not `canceled`) - ambiguous names
are where even a 14B occasionally guesses a wrong column.

### Can it run fully offline, with nothing leaving my machine?

Yes. Run a local model through Ollama (or any OpenAI-compatible local server like LM Studio or
vLLM) and keep the database local. Only the schema and question ever reach the model, and with
a local model that never leaves your machine at all.

`allowDataInPrompt` is the one setting that changes that, and it is off by default. Off, sampled
cell values are stripped from the catalog before any prompt is built, so a connector that samples
cannot leak them. On, they are rendered into the schema block as `sample values: a|b|c`, and that
schema block goes into every prompt: the first SQL prompt, not just a repair, plus `explain` and
`explainSchema`. Declared enum labels are part of the schema and are kept either way. The setting
exists on the MongoDB path too, where it gates sampled field values from document sampling.

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

It is an early (pre-1.0; `@asksql/core` is at `0.6.x`) but functional release: the pipeline
(schema to SQL to guard to execute), the safety guard, the six database adapters, the server
sidecar, the React UI, and the MCP server are all working and tested against live databases
and multiple providers. Treat
generated SQL for complex analytics as reviewable draft, keep credentials on the server sidecar,
and pin the versions you deploy.

## Accuracy depends on the model and the question

Be clear-eyed about what AskSQL guarantees. The guard guarantees **safety** - the SQL is
read-only and is shown to you before it runs. It does **not** guarantee the query is
**semantically** what you meant. How good the generated SQL is depends on two things:

- **How capable your model is.** AskSQL is built to run fully offline on a local coder model -
  pick one sized to your workload (see the rule of thumb below), and if you ever need to, a
  cloud model is an option for the heaviest analytics, never a requirement.
- **How complex the question is.** Single-table filters and simple joins are reliable across the
  board. But multi-table analytics - especially aggregating measures across several
  one-to-many tables at once - can trip a smaller model into a classic **join fan-out**
  (summing over a row-multiplied result and inflating the total), or a hallucinated column, even
  though the SQL is valid and the guard passes. Both of those are caught before the query runs:
  invented columns against the schema, and a fan-out against your foreign keys, each sending the
  query back to be rewritten.

**Rule of thumb, from real testing.** The more tables a question must join, and the larger or
more inconsistently-named your schema, the more model capability you need:

| Your situation | What to use |
|----------------|-------------|
| Small, clean schema; simple or few-table questions | A 1.5B-3B is fine (it handled a 5-table join on a tidy schema in our tests). |
| Complex schema (many tables), questions needing several joins | Use **7B or larger**. A 1.5B failed outright on a real 63-table schema; a 7B matched a 14B. |
| Very deep joins (4+ tables) on an inconsistently-named schema | Even a 14B can slip on a wrong column - review the SQL, and prefer consistent naming (`service_id`, not `id`). |

In our testing the **7B** (for example `qwen2.5-coder:7b`) is the sweet spot for accuracy
against speed, and it is easy to run locally.

The table above is field experience on private schemas that are not in this repository, so unlike
the benchmark below you cannot re-run it. Treat it as guidance; the numbers you can check yourself
are in the next section.

### Measured, and reproducible

Load the fixtures in `packages/postgres/test/fixture.sql` and `packages/mysql/test/fixture.sql`,
build the workspace (`pnpm install && pnpm build`), then run
`node tools/benchmark/run.mjs qwen2.5-coder:1.5b qwen2.5-coder:7b qwen2.5-coder:14b`. It asks seven
data questions, executes the SQL that comes back, and scores a question right only when the
returned rows contain the expected value **and** the row count matches what a correct answer
would produce, so a `SELECT *` that happens to include the word is still wrong. Seven more
questions test whether AskSQL stays in its lane.

| Model | SQL correct | Blocked by the guard | Scope correct | DELETE request | Median ask | Median schema answer |
|---|---|---|---|---|---|---|
| `qwen2.5-coder:1.5b` | 5/7 | 2 | 7/7 | statement + note | 1.1s | 0.5s |
| `qwen2.5-coder:7b` | 7/7 | 0 | 7/7 | statement + note | 2.7s | 1.6s |
| `qwen2.5-coder:14b` | 7/7 | 0 | 7/7 | statement + note | 4.6s | 3.6s |

*Apple M4 Pro, 24 GB, Ollama 0.20.3, 2026-08-01.* The **DELETE request** column is not a model
score: every model returned the statement as text, and the "AskSQL is read-only and never executed
this" note beside it is appended by AskSQL, not written by the model. It is there to show the
safety net firing on all three.

Read it for what it is: a small schema and a handful of questions, not a Spider-style benchmark,
and latency is whatever your machine does. What it does show is the shape of the trade-off - a 7B
matched a 14B here at roughly half the latency, which is why it is the default recommendation.

The **blocked** column is the interesting one. Those are not wrong answers: the 1.5B invented a
`product_id` column on a view, and AskSQL refused to run the query, told the user which columns
that view really has, and left the database untouched. A small model fails loudly here rather
than returning a confident wrong number.

Practical guidance: **review the generated SQL** (it is always shown first; set
`requireApproval` to force a click), give heavy analytics a more capable local model, and treat
the numbers on complex multi-join aggregations as draft until you have sanity-checked them.
Prompt guidance (`config.prompts.instructions`) and a larger model both help; neither makes
review optional.
