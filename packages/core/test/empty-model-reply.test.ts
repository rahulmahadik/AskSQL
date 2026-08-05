/**
 * A model that returns nothing is a different problem from a model that returns bad SQL, and the
 * message has to say which. A hosted deployment that the account cannot reach answers with an
 * empty body; reporting that as "couldn't produce valid SQL" sends the user to rewrite a question
 * that was never the problem.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAskSql } from '../src/index.js';
import { SqliteConnector } from '@asksql/sqlite';

function harness(model: () => Promise<string>) {
  const file = join(mkdtempSync(join(tmpdir(), 'asksql-empty-')), 'shop.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO orders VALUES (1,'paid');");
  db.close();
  const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
  const engine = createAskSql({ connectors: [connector], model: async () => model() });
  return { engine, close: () => connector.close() };
}

describe('a model that says nothing is reported as unreachable', () => {
  it('names the model, not the SQL, when every reply is empty', async () => {
    const { engine, close } = harness(async () => '');
    await expect(engine.ask('how many orders are there')).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
    await close();
  });

  it('treats whitespace as empty too', async () => {
    const { engine, close } = harness(async () => '   \n  ');
    await expect(engine.ask('how many orders are there')).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
    await close();
  });

  it('still reports bad output when the model replies with prose but no SQL', async () => {
    const { engine, close } = harness(async () => 'I think you should look at the orders table.');
    await expect(engine.ask('how many orders are there')).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
    await close();
  });
});
