# @asksql/mcp

Model Context Protocol tools for [AskSQL](https://github.com/rahulmahadik/AskSQL). Exposes four tools to any
MCP client (Claude Desktop, IDE agents, and others): list connections, get the
schema catalog, translate a question to SQL, and run an approved read-only
query. The same AST guard applies to every call, so an agent can never run a
write - a `DELETE` through `asksql_run` returns `GUARD_BLOCKED`.

```bash
npm i @asksql/core @asksql/mcp @modelcontextprotocol/sdk
```

Serve over stdio (the shape an MCP host launches):

```ts
import { createAskSql } from '@asksql/core';
import { startAskSqlMcpServer } from '@asksql/mcp';

const engine = createAskSql({ connectors: [/* ... */], model });
await startAskSqlMcpServer(engine); // speaks MCP over stdin/stdout
```

Or get the tool definitions to wire into a custom transport:

```ts
import { createAskSqlMcpTools } from '@asksql/mcp';
const tools = createAskSqlMcpTools(engine);
```

The SDK is an optional peer dependency: `createAskSqlMcpTools` works without it;
`startAskSqlMcpServer` needs `@modelcontextprotocol/sdk`.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
