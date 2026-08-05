/**
 * MCP tool handlers over a mock-model engine. Verifies the four tools work
 * and - critically - that the engine's guard/read-only enforcement still
 * applies when an AGENT drives AskSQL (a write via asksql_run is blocked).
 */
import { describe, expect, it } from 'vitest';
import {
  createAskSql,
  POSTGRES_DIALECT,
  type Connector,
  type CustomModel,
  type ResultSet,
  type SchemaCatalog,
} from '@asksql/core';
import { createAskSqlMcpTools, buildAskSqlMcpServer } from '../src/index.js';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'users',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'name', dbType: 'text', nullable: true },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
    {
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'user_id', dbType: 'bigint', nullable: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [{ columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
  ],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
};
class Fake implements Connector {
  engine = 'postgres' as const;
  dialect = POSTGRES_DIALECT;
  capabilities = {
    supportsCancel: true,
    supportsExplain: true,
    supportsSchemas: true,
    readOnlySession: true,
    supportsMatViews: true,
    supportsTriggers: true,
    supportsRoutines: true,
  };
  id = 'db';
  name = 'DB';
  async connect() {}
  async close() {}
  async introspect() {
    return CATALOG;
  }
  async execute(): Promise<ResultSet> {
    return {
      columns: [
        { name: 'id', kind: 'bigint' },
        { name: 'name', kind: 'text' },
      ],
      rows: [['1', 'Ada']],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
      warnings: [],
    };
  }
}
const model: CustomModel = async () => '```sql\nSELECT id, name FROM users\n```\nAll users.';

function tools() {
  const engine = createAskSql({ connectors: [new Fake()], model });
  return Object.fromEntries(createAskSqlMcpTools(engine).map((t) => [t.name, t]));
}
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

describe('AskSQL MCP tools', () => {
  it('asksql_list_connections lists the DBs', async () => {
    const res = await tools()['asksql_list_connections']!.handle({});
    expect(parse(res)[0].id).toBe('db');
  });

  it('asksql_schema returns tables + columns', async () => {
    const res = await tools()['asksql_schema']!.handle({});
    const schema = parse(res);
    expect(schema.tables[0].name).toBe('users');
    expect(schema.tables[0].columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name']);
  });

  it('asksql_query returns SQL + explanation without executing', async () => {
    const res = await tools()['asksql_query']!.handle({ question: 'list users' });
    const out = parse(res);
    expect(out.sql).toMatch(/SELECT id, name FROM users/i);
    expect(out.explanation).toMatch(/all users/i);
    expect(out).not.toHaveProperty('rows');
  });

  it('asksql_run executes an approved SELECT', async () => {
    const res = await tools()['asksql_run']!.handle({ sql: 'SELECT id, name FROM users' });
    const out = parse(res);
    expect(out.columns).toEqual(['id', 'name']);
    expect(out.rowCount).toBe(1);
  });

  it('asksql_run BLOCKS a write (guard applies to agents too)', async () => {
    const res = await tools()['asksql_run']!.handle({ sql: 'DELETE FROM users' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/GUARD_BLOCKED/);
  });

  it('asksql_query answers from the catalog when no query can be built', async () => {
    let call = 0;
    const engine = createAskSql({
      connectors: [new Fake()],
      // First the SQL attempt gives up; the prose path then answers from the schema.
      model: async () =>
        ++call === 1 ? 'IMPOSSIBLE: not answerable from this schema' : 'The users table holds one row per person.',
    });
    const t = Object.fromEntries(createAskSqlMcpTools(engine).map((x) => [x.name, x]));
    const res = await t['asksql_query']!.handle({ question: 'what is this database for' });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.answer).toBeTruthy();
    expect(parsed.grounded).toBeDefined();
  });

  it('a model that kept inventing a table is reported, not relabelled as "no query answers this"', async () => {
    const engine = createAskSql({
      connectors: [new Fake()],
      // Names a table that does not exist, every time: the engine gives up with a "Did you mean".
      model: async () => '```sql\nSELECT * FROM usrs\n```',
    });
    const t = Object.fromEntries(createAskSqlMcpTools(engine).map((x) => [x.name, x]));
    const res = await t['asksql_query']!.handle({ question: 'how many users' });
    expect(res.isError).toBe(true);
    // The actionable part of the message must survive to the agent.
    expect(res.content[0]!.text).toMatch(/usrs/);
  });

  it('asksql_query still errors when the failure is not about the question', async () => {
    const engine = createAskSql({
      connectors: [new Fake()],
      model: async () => {
        throw Object.assign(new Error('no key'), { code: 'LLM_AUTH' });
      },
    });
    const t = Object.fromEntries(createAskSqlMcpTools(engine).map((x) => [x.name, x]));
    const res = await t['asksql_query']!.handle({ question: 'how many users' });
    expect(res.isError).toBe(true);
  });

  it('asksql_query answers an advice question in prose instead of dead-ending the agent', async () => {
    const engine = createAskSql({
      connectors: [new Fake()],
      model: async () => 'Add an index on users(name) and a foreign key from orders to users.',
    });
    const t = Object.fromEntries(createAskSqlMcpTools(engine).map((x) => [x.name, x]));
    const res = await t['asksql_query']!.handle({ question: 'how can I improve this schema' });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.answer).toBeTruthy();
    expect(parsed.note).toMatch(/read-only/i);
  });

  it('asksql_explain_schema answers a schema question directly', async () => {
    const engine = createAskSql({
      connectors: [new Fake()],
      model: async () => 'The users table holds one row per person; orders references it by user id.',
    });
    const t = Object.fromEntries(createAskSqlMcpTools(engine).map((x) => [x.name, x]));
    const res = await t['asksql_explain_schema']!.handle({ question: 'how are these tables related' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text).answer).toBeTruthy();
  });

  it('asksql_schema surfaces a clean error when introspection fails', async () => {
    class Throwing extends Fake {
      override async introspect(): Promise<SchemaCatalog> {
        throw new Error('permission denied for schema');
      }
    }
    const engine = createAskSql({ connectors: [new Throwing()], model });
    const t = Object.fromEntries(createAskSqlMcpTools(engine).map((x) => [x.name, x]));
    const res = await t['asksql_schema']!.handle({});
    expect(res.isError).toBe(true);
  });

  it('asksql_run surfaces a clean error when the query fails at the database', async () => {
    class BadExec extends Fake {
      override async execute(): Promise<ResultSet> {
        throw new Error('relation does not exist');
      }
    }
    const engine = createAskSql({ connectors: [new BadExec()], model });
    const t = Object.fromEntries(createAskSqlMcpTools(engine).map((x) => [x.name, x]));
    const res = await t['asksql_run']!.handle({ sql: 'SELECT id, name FROM users' });
    expect(res.isError).toBe(true);
  });
});

// A real client <-> server round-trip over the actual MCP SDK (in-memory
// transport, real JSON-RPC). This is what catches SDK-contract mismatches a
// mock server hides - e.g. the low-level Server accepting our JSON Schema
// inputSchema, which the high-level McpServer.registerTool rejects.
describe('MCP protocol over the real SDK', () => {
  it('lists tools and invokes them through a real client, guard enforced', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const engine = createAskSql({ connectors: [new Fake()], model });
    const server = await buildAskSqlMcpServer(engine);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'asksql-test', version: '0.0.0' });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      ['asksql_list_connections', 'asksql_query', 'asksql_run', 'asksql_explain_schema'].concat('asksql_schema').sort(),
    );
    // The advertised inputSchema is real JSON Schema (object type).
    expect(listed.tools.find((t) => t.name === 'asksql_query')?.inputSchema.type).toBe('object');

    const q = await client.callTool({ name: 'asksql_query', arguments: { question: 'list users' } });
    const parsed = JSON.parse((q.content as { text: string }[])[0]!.text);
    expect(parsed.sql).toMatch(/SELECT id, name FROM users/i);

    const write = await client.callTool({ name: 'asksql_run', arguments: { sql: 'DELETE FROM users' } });
    expect(write.isError).toBe(true);
    expect((write.content as { text: string }[])[0]!.text).toMatch(/GUARD_BLOCKED/);

    await client.close();
  });
});
