/**
 * AskSQL MCP tool definitions + handlers, framework-agnostic so they wire to any MCP
 * transport: asksql_list_connections, asksql_schema, asksql_query (generates SQL without
 * running it), asksql_explain_schema, and asksql_run. The engine's guard and read-only
 * enforcement apply to every call, so an agent using these tools cannot run a write.
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

/**
 * The engine's own `detail` when no query exists for the question. Keyed on detail, not on
 * LLM_BAD_OUTPUT, which also covers a model that simply failed.
 */
const NO_QUERY_EXISTS: ReadonlySet<string> = new Set([
  'schema-advice question routed to the prose path',
  'write request routed to the proposal path',
  'capability question routed to the prose path',
  'model returned IMPOSSIBLE sentinel',
]);

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
        const question = String(args['question'] ?? '');
        const connectionId = args['connectionId'] as string | undefined;
        try {
          const ans = await engine.ask(question, { connectionId });
          return ok({
            sql: ans.sql,
            explanation: ans.explanation,
            connectionId: ans.connectionId,
            autoLimited: ans.guard.autoLimited,
          });
        } catch (err) {
          // Advice, write requests, and questions this schema cannot answer fall back to the
          // catalog-grounded prose path, as every other surface does.
          if (AskSqlError.is(err) && NO_QUERY_EXISTS.has(err.detail ?? '')) {
            try {
              const answer = await engine.explainSchema(question, { connectionId });
              return ok({
                answer: answer.answer,
                grounded: answer.grounded,
                unknownReferences: answer.unknownReferences,
                isSchemaChange: answer.isSchemaChange,
                connectionId,
                note: 'No query answers this. AskSQL is read-only; any statement above is a proposal to run yourself.',
              });
            } catch {
              return toUserError(err);
            }
          }
          return toUserError(err);
        }
      },
    },
    {
      name: 'asksql_explain_schema',
      description:
        'Answer a question about the database itself - how tables relate, what to index, how to improve the schema, or a write statement to run yourself. Grounded in the catalog; runs nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'A question about the schema rather than the data.' },
          connectionId: { type: 'string' },
        },
        required: ['question'],
        additionalProperties: false,
      },
      async handle(args) {
        try {
          const answer = await engine.explainSchema(String(args['question'] ?? ''), {
            connectionId: args['connectionId'] as string | undefined,
          });
          return ok({
            answer: answer.answer,
            grounded: answer.grounded,
            unknownReferences: answer.unknownReferences,
            isSchemaChange: answer.isSchemaChange,
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
