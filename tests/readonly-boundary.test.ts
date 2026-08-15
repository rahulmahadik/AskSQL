/**
 * The read-only promise at the MCP surface, where an agent reaches it. Covers the statements that
 * read like reads - EXPLAIN ANALYZE executes its subject, a CTE can carry a DELETE - and the plain
 * reads that must keep working, since a boundary that refuses everything is no better than one that
 * refuses nothing. SQLite and a stub model, so it needs no external infrastructure.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAskSql } from '@asksql/core';
import { createAskSqlMcpTools, type McpToolDef } from '@asksql/mcp';
import { SqliteConnector } from '@asksql/sqlite';

function seedDatabase(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'asksql-readonly-')), 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, full_name TEXT, region TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_cents INTEGER);
    INSERT INTO customers VALUES (1, 'Ada', 'EU'), (2, 'Grace', 'US');
    INSERT INTO orders VALUES (1, 1, 500), (2, 2, 700);
  `);
  db.close();
  return file;
}

function tools(): { run: McpToolDef; all: McpToolDef[] } {
  const connector = new SqliteConnector({ id: 'db', name: 'Shop', file: seedDatabase() });
  const engine = createAskSql({ connectors: [connector], model: async () => '```sql\nSELECT 1\n```\nx.' });
  const all = createAskSqlMcpTools(engine);
  return { run: all.find((t) => t.name === 'asksql_run')!, all };
}

const MUST_REFUSE: readonly (readonly [string, string])[] = [
  ['a plain delete', 'DELETE FROM customers'],
  ['a plain update', 'UPDATE customers SET region = 1'],
  ['an insert', "INSERT INTO customers (full_name) VALUES ('x')"],
  ['a drop', 'DROP TABLE customers'],
  ['a create', 'CREATE TABLE evil (a int)'],
  ['an alter', 'ALTER TABLE customers ADD COLUMN x int'],
  ['a case-mixed write', 'dElEtE FROM customers'],
  ['a stacked statement', 'SELECT 1; DELETE FROM customers'],
  ['a statement hidden behind a comment', 'SELECT 1 /* harmless */; DELETE FROM customers'],
  ['a write inside a CTE', 'WITH d AS (DELETE FROM customers RETURNING 1) SELECT * FROM d'],
  [
    'a write inside a nested CTE',
    'WITH a AS (SELECT 1), b AS (UPDATE customers SET region = 1 RETURNING 1) SELECT * FROM b',
  ],
  // EXPLAIN ANALYZE is not a read: it executes the statement it is given.
  ['EXPLAIN ANALYZE over a delete', 'EXPLAIN ANALYZE DELETE FROM customers'],
  ['SELECT INTO, which creates a table', 'SELECT * INTO evil_copy FROM customers'],
  ['CREATE TABLE AS', 'CREATE TABLE evil2 AS SELECT * FROM customers'],
  ['ATTACH, which opens another file', "ATTACH DATABASE '/tmp/evil.db' AS evil"],
  ['a pragma that writes', 'PRAGMA journal_mode = WAL'],
  ['a transaction control statement', 'BEGIN'],
  ['a vacuum', 'VACUUM'],
  ['an empty statement', ''],
  ['prose rather than SQL', 'please delete everything'],
];

const MUST_ALLOW: readonly (readonly [string, string])[] = [
  ['a plain select', 'SELECT id, full_name FROM customers'],
  ['a join', 'SELECT c.full_name, o.total_cents FROM customers c JOIN orders o ON o.customer_id = c.id'],
  ['an aggregate', 'SELECT COUNT(*) AS n FROM customers'],
  ['a read-only CTE', 'WITH c AS (SELECT * FROM customers) SELECT COUNT(*) AS n FROM c'],
  ['a union', 'SELECT id FROM customers UNION SELECT id FROM orders'],
  ['a subquery', 'SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders)'],
  ['a window function', 'SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM customers'],
  // A keyword inside a string literal is data, not a statement.
  ['a write keyword inside a literal', "SELECT 'DELETE FROM customers' AS not_a_statement"],
  ['a column aliased to a keyword', 'SELECT id AS "update" FROM customers'],
];

describe('the read-only boundary at the MCP surface', () => {
  // GUARD_BLOCKED specifically, not merely an error: a read-only connection would also refuse a
  // write, which would let this pass while the guard itself had stopped working.
  it.each(MUST_REFUSE)('refuses %s at the guard', async (_label, sql) => {
    const { run } = tools();
    const result = await run.handle({ sql });
    expect(result.isError, `allowed: ${sql}`).toBe(true);
    expect(result.content[0]?.text, `not stopped by the guard: ${sql}`).toContain('GUARD_BLOCKED');
  });

  it.each(MUST_ALLOW)('runs %s', async (_label, sql) => {
    const { run } = tools();
    const result = await run.handle({ sql });
    expect(result.isError, `blocked: ${sql} -> ${result.content[0]?.text}`).not.toBe(true);
  });

  it('leaves the data untouched after every refused write', async () => {
    const { run } = tools();
    for (const [, sql] of MUST_REFUSE) await run.handle({ sql });
    const after = await run.handle({ sql: 'SELECT COUNT(*) AS n FROM customers' });
    expect(after.isError).not.toBe(true);
    expect(JSON.parse(after.content[0]!.text).rows).toEqual([[2]]);
  });

  it('reports bad input as a tool error rather than throwing', async () => {
    const { run } = tools();
    for (const args of [{}, { sql: null }, { sql: { a: 1 } }, { sql: 'SELECT 1', connectionId: 'nope' }]) {
      const result = await run.handle(args as Record<string, unknown>);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
  });

  it('declares an input schema an MCP client can validate against', async () => {
    const { all } = tools();
    expect(all.map((t) => t.name)).toEqual([
      'asksql_list_connections',
      'asksql_schema',
      'asksql_query',
      'asksql_explain_schema',
      'asksql_run',
    ]);
    for (const tool of all) {
      expect(tool.inputSchema['type'], tool.name).toBe('object');
      expect(tool.inputSchema['additionalProperties'], tool.name).toBe(false);
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });
});
