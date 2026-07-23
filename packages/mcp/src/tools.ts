/**
 * AskSQL MCP tool definitions + handlers, framework-agnostic so they can be
 * unit-tested directly and wired to any MCP transport. Four tools:
 *
 * asksql_list_connections - enumerate available databases
 * asksql_schema - the catalog for a connection (what you can ask)
 * asksql_query - NL question -> generated SQL + explanation (NOT run)
 * asksql_run - execute an approved SELECT (guarded, read-only)
 *
 * The guard + read-only enforcement of the engine apply to every call, so an
 * agent using these tools can never run a write - the same safety as the UI.
 */

import { AskSqlError, type AskSqlEngine } from '@asksql/core';

export interface McpToolResult {
  readonly content: { type: 'text'; text: string }[];
  readonly isError?: boolean;
}

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  handle(args: Record<string, unknown>): Promise<McpToolResult>;
}

const ok = (obj: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
});
const fail = (message: string): McpToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

function toUserError(err: unknown): McpToolResult {
  const e = AskSqlError.from(err, 'CONFIG_ERROR');
  return fail(`${e.code}: ${e.userMessage}`);
}

export function createAskSqlMcpTools(engine: AskSqlEngine): McpToolDef[] {
  return [
    {
      name: 'asksql_list_connections',
      description: 'List the databases AskSQL can query (id, name, engine, database).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handle() {
        return ok(engine.connectors);
      },
    },
    {
      name: 'asksql_schema',
      description: 'Get the schema catalog (tables, columns, relationships) for a connection - what you can ask about.',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: {
            type: 'string',
            description: 'Connection id (optional; defaults to the first).',
          },
        },
        additionalProperties: false,
      },
      async handle(args) {
        try {
          const catalog = await engine.catalog(args['connectionId'] as string | undefined);
          // Trim to the essentials for an agent's context window.
          return ok({
            engine: catalog.engine,
            tables: catalog.tables
              .filter((t) => !t.partitionOf)
              .map((t) => ({
                name: t.schema ? `${t.schema}.${t.name}` : t.name,
                kind: t.kind,
                columns: t.columns.map((c) => ({
                  name: c.name,
                  type: c.dbType,
                  pk: t.primaryKey.includes(c.name),
                })),
                foreignKeys: t.foreignKeys.map((f) => ({
                  columns: f.columns,
                  refTable: f.refTable,
                  refColumns: f.refColumns,
                })),
              })),
          });
        } catch (err) {
          return toUserError(err);
        }
      },
    },
    {
      name: 'asksql_query',
      description:
        'Translate a natural-language question into a read-only SQL query. Returns the SQL and an explanation. Does NOT execute it - call asksql_run to execute.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question in plain language.' },
          connectionId: { type: 'string' },
        },
        required: ['question'],
        additionalProperties: false,
      },
      async handle(args) {
        try {
          const ans = await engine.ask(String(args['question'] ?? ''), {
            connectionId: args['connectionId'] as string | undefined,
          });
          return ok({
            sql: ans.sql,
            explanation: ans.explanation,
            connectionId: ans.connectionId,
            autoLimited: ans.guard.autoLimited,
          });
        } catch (err) {
          return toUserError(err);
        }
      },
    },
    {
      name: 'asksql_run',
      description: 'Execute an approved read-only SQL query (SELECT only; guarded). Returns columns + rows.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single read-only SELECT statement.' },
          connectionId: { type: 'string' },
          maxRows: { type: 'number' },
        },
        required: ['sql'],
        additionalProperties: false,
      },
      async handle(args) {
        try {
          const result = await engine.execute(String(args['sql'] ?? ''), {
            connectionId: args['connectionId'] as string | undefined,
            maxRows: typeof args['maxRows'] === 'number' ? (args['maxRows'] as number) : undefined,
          });
          return ok({
            columns: result.columns.map((c) => c.name),
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
          });
        } catch (err) {
          return toUserError(err);
        }
      },
    },
  ];
}
