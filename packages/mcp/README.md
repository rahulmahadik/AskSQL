# @asksql/mcp

Model Context Protocol tools for [AskSQL](https://github.com/rahulmahadik/AskSQL). Exposes four
tools to any MCP client (Claude Desktop, Claude Code, IDE agents):

| Tool | What it does |
|---|---|
| `asksql_list_connections` | The databases you configured, with engine and name |
| `asksql_schema` | The schema catalog for one connection: tables, columns, keys |
| `asksql_query` | Turns a question into SQL and returns it — **never executes it** |
| `asksql_run` | Executes an approved read-only SELECT and returns rows |

The same AST guard applies to every call, so an agent can never write: a `DELETE` through
`asksql_run` comes back `GUARD_BLOCKED`, and so does a write smuggled in as a second statement.

```bash
npm i @asksql/core @asksql/mcp @modelcontextprotocol/sdk
```

## Setting it up in an MCP host

An MCP host launches your server as a subprocess and talks to it over stdin/stdout, so you
write one small file that says which databases to expose and which model to use. There is no
`asksql-mcp` binary on purpose — connection details and credentials are yours to control.

Save this as `asksql-mcp-server.mjs` anywhere, and install the connector for your database
alongside the packages above (here, `@asksql/postgres` and `pg`):

```js
import { createAskSql, resolveModel } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';
import { startAskSqlMcpServer } from '@asksql/mcp';

const engine = createAskSql({
  connectors: [
    new PostgresConnector({
      id: 'app',
      name: 'App database',
      connectionString: process.env.DATABASE_URL,
    }),
  ],
  model: await resolveModel({ provider: 'ollama', model: 'qwen2.5-coder:7b' }),
});

await startAskSqlMcpServer(engine); // speaks MCP over stdin/stdout
```

Then register it. **Claude Desktop** — edit `claude_desktop_config.json`, which lives at
`~/Library/Application Support/Claude/` on macOS and `%APPDATA%\Claude\` on Windows, and
restart the app:

```json
{
  "mcpServers": {
    "asksql": {
      "command": "node",
      "args": ["/absolute/path/to/asksql-mcp-server.mjs"],
      "env": { "DATABASE_URL": "postgres://user:pass@localhost:5432/app" }
    }
  }
}
```

**Claude Code** — one command instead of editing a file:

```bash
claude mcp add asksql -- node /absolute/path/to/asksql-mcp-server.mjs
```

The path must be absolute: the host does not launch the server from your project directory.
Anything the server writes to stdout other than protocol traffic corrupts the connection, so
log to stderr (`console.error`) if you need to debug, never `console.log`.

## Checking it works

Ask the assistant to list your connections. It should call `asksql_list_connections` and come
back with the `id` and `name` you configured. If nothing appears, the server failed to start —
run `node /absolute/path/to/asksql-mcp-server.mjs` in a terminal and look for the error. It
should sit there silently waiting for protocol input; anything else is the problem.

To confirm the read-only guarantee for yourself, ask it to delete a row. The statement comes
back refused, and the row is still there.

## Custom transports

`createAskSqlMcpTools(engine)` returns the raw tool definitions and handlers, for wiring into
a transport of your own or for testing:

```ts
import { createAskSqlMcpTools } from '@asksql/mcp';
const tools = createAskSqlMcpTools(engine);
```

`@modelcontextprotocol/sdk` is an optional peer dependency: `createAskSqlMcpTools` works
without it, and only `startAskSqlMcpServer` needs it.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
