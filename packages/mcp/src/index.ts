/**
 * @asksql/mcp - expose an AskSQL engine over the Model Context Protocol.
 *
 * import { createAskSql } from '@asksql/core';
 * import { PostgresConnector } from '@asksql/postgres';
 * import { startAskSqlMcpServer } from '@asksql/mcp';
 *
 * const engine = createAskSql({ connectors: [...], model });
 * await startAskSqlMcpServer(engine); // serves over stdio
 *
 * `@modelcontextprotocol/sdk` is an optional peer - the tool defs/handlers
 * (`createAskSqlMcpTools`) are usable without it for tests or custom transports.
 */

import { AskSqlError, type AskSqlEngine } from '@asksql/core';
import { createAskSqlMcpTools, type McpToolDef, type McpToolResult } from './tools.js';

export { createAskSqlMcpTools } from './tools.js';
export type { McpToolDef, McpToolResult } from './tools.js';

export interface McpServerOptions {
  readonly name?: string;
  readonly version?: string;
}

/** Minimal shape of the SDK's low-level Server that we depend on. */
export interface McpLowLevelServer {
  setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<unknown> | unknown): void;
  connect(transport: unknown): Promise<void>;
}

/**
 * Build a low-level MCP server that advertises AskSQL's tools and dispatches
 * calls to their handlers. The low-level `Server` (not the high-level
 * `McpServer`) is used deliberately: it takes each tool's JSON Schema
 * `inputSchema` as-is, whereas `McpServer.registerTool` only accepts Zod raw
 * shapes. Returned unconnected so callers attach their own transport (stdio,
 * an in-memory transport for tests, a custom host).
 */
export async function buildAskSqlMcpServer(
  engine: AskSqlEngine,
  opts: McpServerOptions = {},
): Promise<McpLowLevelServer> {
  let Server: new (
    info: { name: string; version: string },
    options: { capabilities: { tools: object } },
  ) => McpLowLevelServer;
  let ListToolsRequestSchema: unknown;
  let CallToolRequestSchema: unknown;
  try {
    const serverMod = (await import('@modelcontextprotocol/sdk/server/index.js')) as { Server: typeof Server };
    const typesMod = (await import('@modelcontextprotocol/sdk/types.js')) as {
      ListToolsRequestSchema: unknown;
      CallToolRequestSchema: unknown;
    };
    Server = serverMod.Server;
    ListToolsRequestSchema = typesMod.ListToolsRequestSchema;
    CallToolRequestSchema = typesMod.CallToolRequestSchema;
  } catch (err) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: `MCP SDK not installed: ${err instanceof Error ? err.message : String(err)}`,
      userMessage: 'The MCP server needs @modelcontextprotocol/sdk. Run: npm install @modelcontextprotocol/sdk',
      cause: err,
    });
  }

  const tools = createAskSqlMcpTools(engine);
  const byName = new Map<string, McpToolDef>(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: opts.name ?? 'asksql', version: opts.version ?? '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<McpToolResult> => {
    const params = (request as { params?: { name?: string; arguments?: Record<string, unknown> } }).params ?? {};
    const tool = params.name ? byName.get(params.name) : undefined;
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${params.name ?? '(none)'}` }], isError: true };
    }
    return tool.handle(params.arguments ?? {});
  });

  return server;
}

/** Start an MCP server over stdio exposing the engine's tools. */
export async function startAskSqlMcpServer(engine: AskSqlEngine, opts: McpServerOptions = {}): Promise<void> {
  const server = await buildAskSqlMcpServer(engine, opts);
  const { StdioServerTransport } = (await import('@modelcontextprotocol/sdk/server/stdio.js')) as {
    StdioServerTransport: new () => unknown;
  };
  await server.connect(new StdioServerTransport());
}
