/**
 * A prose answer often ends in a query, and the next thing a user types is "run that". Unless the
 * answer hands the query back, the follow-up has no prior SQL to refer to and is answered as a
 * fresh question, which is how "run the aggregation you just showed me" became SELECT * FROM one table.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAskSql } from '@asksql/core';
import { SqliteConnector } from '@asksql/sqlite';

function harness(reply: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'asksql-proposed-')), 'shop.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);');
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT);');
  db.close();
  const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
  const engine = createAskSql({ connectors: [connector], model: async () => reply, answerSchemaQuestions: true });
  return { engine, close: () => connector.close() };
}

describe('a query suggested in prose is handed back for the next turn', () => {
  it('returns the read-only query the answer proposed', async () => {
    const { engine, close } = harness(
      'You can join them like this:\n\n```sql\nSELECT c.id, COUNT(o.id) AS n FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id\n```\n\nThat counts orders per customer.',
    );
    const answer = await engine.explainSchema('how do I join these tables and aggregate');
    expect(answer.proposedSql).toContain('JOIN orders');
    expect(answer.proposedSql).toContain('GROUP BY');
    close();
  });

  it('carries nothing when the answer suggested no query', async () => {
    const { engine, close } = harness('The orders table records purchases, one row per order.');
    const answer = await engine.explainSchema('what does the orders table hold');
    expect(answer.proposedSql).toBeUndefined();
    close();
  });

  it('carries nothing when the answer invented a column', async () => {
    // Read-only but unusable: prose is not held to the hallucination floor the ask path applies.
    const { engine, close } = harness(
      'Try this:\n\n```sql\nSELECT c.id, SUM(o.grand_total) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id\n```',
    );
    const answer = await engine.explainSchema('how do I total orders per customer');
    expect(answer.proposedSql).toBeUndefined();
    close();
  });

  it('carries nothing when the answer invented a table', async () => {
    const { engine, close } = harness('Use:\n\n```sql\nSELECT * FROM order_line_items\n```');
    const answer = await engine.explainSchema('where are the line items');
    expect(answer.proposedSql).toBeUndefined();
    close();
  });

  // A write is shown as a proposal to run by hand; "run that" must never resolve to it.
  it('never carries a write proposal', async () => {
    const { engine, close } = harness(
      "To remove them, run:\n\n```sql\nDELETE FROM orders WHERE status = 'cancelled'\n```\n\nCheck the rows first.",
    );
    const answer = await engine.explainSchema('write a statement that deletes cancelled orders');
    expect(answer.proposedSql).toBeUndefined();
    close();
  });
});
