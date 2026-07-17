# AskSQL for VS Code

**Ask your database in plain English. See the SQL. Get the answer - without leaving VS Code.**

AskSQL adds a chat panel to your sidebar. Type a question, and it writes a read-only SQL query,
shows it to you, runs it, and returns the results as a table. Works with PostgreSQL, MySQL /
MariaDB, and SQLite, using whichever AI model you choose.

```
how many appointments were booked last week?
```

## Features

- **Plain-language questions, real SQL.** Every answer shows the exact query it ran, with a short
  explanation. Nothing is hidden.
- **Read-only by design.** A deterministic guard - not the prompt - decides what runs. Writes, DDL,
  and stacked statements are refused before the database ever sees them. Ask it to delete something
  and it says no.
- **Your rows stay private.** The model is sent your **schema and your question, never your data**.
  With a local model, nothing leaves your machine at all. (One optional setting,
  `asksql.sampleColumnValues`, will additionally show the model the handful of codes a short
  non-enum text column holds - it is off by default and clearly the only thing that sends column
  values.)
- **Results you can use.** An inline table, plus one click to **Copy** (with headers), open the full
  result set or the SQL in an editor, or ask the database for its **query plan**.
- **Schema explorer.** Browse tables, views, columns, and keys in the sidebar - the same schema the
  model is given. Ask "describe the customers table" and it answers instantly from the schema, no
  query and no model call.
- **Self-correcting.** If the model invents a column or misspells a table, AskSQL catches it against
  your real schema and fixes the query before it runs.
- **Bring your own model.** A chat model you already have in VS Code (no API key), a fully local
  Ollama model, or your own OpenAI / Anthropic / Google / Groq key.
- **Credentials in your OS keychain**, never in settings files.

## Databases

PostgreSQL, MySQL / MariaDB, and SQLite - local or in the cloud. Every driver is pure JavaScript or
built into Node, so nothing compiles at install time and nothing breaks on a VS Code update. (SQLite
uses Node's built-in `node:sqlite`, present in VS Code builds on Node 22 or newer.)

For a managed cloud database (Supabase, Neon, RDS, PlanetScale, Aiven, Azure...), either paste the
connection string it gives you, or fill in the fields and turn on SSL - both are offered right in the
Add Connection flow. Connection strings are kept in your OS keychain, never in settings.

## Setup

1. Run **AskSQL: Add Database Connection** (Command Palette, or the button in the AskSQL sidebar).
   It walks you through the details, stores the password in your OS keychain, and tests the
   connection so you know right away that it works.
2. Open the AskSQL panel and ask: `what tables are in this database?`

For the model: if you already have a chat model in VS Code (for example GitHub Copilot's), it is
offered automatically and needs no key. Otherwise run **AskSQL: Select AI Provider** - Ollama (local,
no key), or OpenAI / Anthropic / Google / Groq / any OpenAI-compatible endpoint with your own key.

## Accuracy, honestly

The guard guarantees the query is **safe**, not that it is **what you meant**. Simple filters and
joins are reliable; heavy multi-table analytics can trip a smaller model. The SQL is **always shown**
for exactly this reason - read it. Set `asksql.requireApproval` to require a click before any query
runs, and `asksql.sqlDisplay` to `before` to read every query above its results.

## Your data

Connections save to your **User** settings (private to your machine) by default. You can choose to
save one in the project instead, but AskSQL asks first and spells out that a committed
`.vscode/settings.json` would expose the host, port, user, and database name. **Passwords and API
keys are never written to settings** - they live in your OS keychain.

Uninstalling the extension does not delete any of this: VS Code leaves your settings and keychain
entries in place by design, so a reinstall restores your setup and nothing is lost by accident.
When you actually want a clean slate, run **AskSQL: Remove All Connections and Keys** - it wipes
every connection, every saved database password and API key, and the selected model in one step.

## Commands and settings

Every command and setting is listed in the **Feature Contributions** tab of this page. In short:
Add / Test / Remove Database Connection, **Choose Answering Model**, Set AI Provider API Key, Refresh
Schema, and Clear Chat.

## Open source

AskSQL is Apache-2.0 and built on the [`@asksql`](https://www.npmjs.com/org/asksql) npm packages, so
you can embed the same engine and guard in your own product.

- Source: [github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
- Issues: [github.com/rahulmahadik/AskSQL/issues](https://github.com/rahulmahadik/AskSQL/issues)
- npm packages: [npmjs.com/org/asksql](https://www.npmjs.com/org/asksql)

## Author

Rahul Mahadik - [GitHub](https://github.com/rahulmahadik) - [LinkedIn](https://www.linkedin.com/in/rahulmahadik/)
