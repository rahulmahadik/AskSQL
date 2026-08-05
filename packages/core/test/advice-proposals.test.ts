/**
 * Asked how to improve a schema, the answer proposes indexes and tables that do not exist yet -
 * that is the point of the question. Reporting those as hallucinations warns the user away from
 * the advice they asked for, so advice is labelled the same way a change request is.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAskSql } from '@asksql/core';
import { SqliteConnector } from '@asksql/sqlite';

function harness(reply: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'asksql-advice-')), 'shop.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT);');
  db.close();
  const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
  const engine = createAskSql({ connectors: [connector], model: async () => reply, answerSchemaQuestions: true });
  return { engine, close: () => connector.close() };
}

const PROPOSES_AN_INDEX = 'Add an index named idx_orders_customer_id on orders(customer_id) to speed up the join.';

describe('advice answers are proposals, not hallucinations', () => {
  const ADVICE = [
    'how can I improve this schema',
    'which indexes should I add',
    'how would I partition the largest tables',
    'is my data model missing any constraints',
  ];
  for (const question of ADVICE) {
    it(`marks as a proposal: "${question.slice(0, 42)}"`, async () => {
      const { engine, close } = harness(PROPOSES_AN_INDEX);
      const answer = await engine.explainSchema(question);
      // isSchemaChange drives the wording: "Proposed names..." rather than "treat with caution".
      expect(answer.isSchemaChange).toBe(true);
      await close();
    });
  }

  it('an overview describes what exists, so an unknown name is a hallucination', async () => {
    const { engine, close } = harness('This database tracks orders, customers and shipment_batches.');
    const answer = await engine.explainSchema('give me an overview of this database');
    expect(answer.isSchemaChange).toBe(false);
    expect(answer.unknownReferences).toContain('shipment_batches');
    await close();
  });

  it('an ordinary question is still held to the schema', async () => {
    const { engine, close } = harness('Join orders to customer_history for the totals.');
    const answer = await engine.explainSchema('how are these tables related');
    expect(answer.isSchemaChange).toBe(false);
    expect(answer.unknownReferences).toContain('customer_history');
    expect(answer.grounded).toBe(false);
    await close();
  });
});

describe('a system catalog is a real object, not an invention', () => {
  const CATALOGS: readonly [string, string][] = [
    ['postgres', 'Query pg_indexes and pg_stat_user_indexes to find duplicates.'],
    ['oracle', 'Check user_indexes and all_tables for this.'],
    ['sqlite', 'Look in sqlite_master for the definitions.'],
    ['mysql', 'Read information_schema.statistics for the index list.'],
  ];
  for (const [label, reply] of CATALOGS) {
    it(`does not report ${label} catalogs`, async () => {
      const { engine, close } = harness(reply);
      const answer = await engine.explainSchema('how are these tables related');
      expect(answer.unknownReferences).toEqual([]);
      expect(answer.grounded).toBe(true);
      await close();
    });
  }
});
