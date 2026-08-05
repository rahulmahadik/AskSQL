/**
 * Someone who pastes a write statement and asks about it is discussing a write. The reply must not
 * read as though AskSQL will run it, even when the answer only describes the statement in prose.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAskSql } from '@asksql/core';
import { SqliteConnector } from '@asksql/sqlite';

function harness(reply: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'asksql-note-')), 'shop.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO orders VALUES (1, 'paid');");
  db.close();
  const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
  const engine = createAskSql({ connectors: [connector], model: async () => reply, answerSchemaQuestions: true });
  return { engine, close: () => connector.close() };
}

// The model describes the statement without restating it, so the answer alone never trips the note.
const PROSE_ONLY =
  'That statement is correct. It removes every row in the orders table whose status column is cancelled.';

describe('a pasted write statement carries the read-only note', () => {
  const QUESTIONS = [
    "fix this statement: DELETE FROM orders WHERE status = 'cancelled'",
    "improve this delete: DELETE FROM orders WHERE status = 'cancelled'",
    "is this update safe: UPDATE orders SET status = 'paid' WHERE id = 1",
    'review this migration: ALTER TABLE orders ADD COLUMN note TEXT',
    'what does this do: DROP TABLE orders',
  ];
  for (const question of QUESTIONS) {
    it(`notes: "${question.slice(0, 44)}"`, async () => {
      const { engine, close } = harness(PROSE_ONLY);
      const { answer } = await engine.explainSchema(question);
      expect(answer).toMatch(/read-only/i);
      await close();
    });
  }
});

describe('an ordinary question does not get the note', () => {
  const QUESTIONS = [
    'how many orders were deleted last week',
    'show me cancelled orders',
    'how do I improve this schema',
    'which customers were added in January',
  ];
  for (const question of QUESTIONS) {
    it(`no note: "${question}"`, async () => {
      const { engine, close } = harness('The orders table records purchases and their status.');
      const { answer } = await engine.explainSchema(question);
      expect(answer).not.toMatch(/read-only/i);
      await close();
    });
  }
});
