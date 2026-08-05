/**
 * Does any actual cell value reach the model? Asked often enough to be worth proving rather than
 * asserting: seed distinctive values, run real queries against a real database, capture every
 * prompt the engine sends, and search those prompts for the values.
 *
 * The model is a stub so this runs in CI, but the database, the SQL and the results are real.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAskSql } from '@asksql/core';
import { SqliteConnector } from '@asksql/sqlite';

const SECRETS = {
  email: 'ZZSECRETEMAIL@example.com',
  name: 'ZZSECRETNAME',
  note: 'ZZSECRETNOTE',
  ssn: '987654321987',
};

function seedDatabase(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'asksql-privacy-')), 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, region TEXT, ssn TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, total_cents INTEGER, note TEXT);
    INSERT INTO customers VALUES (1, '${SECRETS.email}', '${SECRETS.name}', 'EU', '${SECRETS.ssn}');
    INSERT INTO orders VALUES (1, 1, 'paid', 500, '${SECRETS.note}');
  `);
  db.close();
  return file;
}

/** Records every prompt, then answers with SQL that reads the secret-bearing columns. */
function recordingModel(seen: string[]) {
  return async ({ system, prompt }: { system: string; prompt: string }): Promise<string> => {
    seen.push(system, prompt);
    return '```sql\nSELECT email, full_name, ssn FROM customers\n```\nReads the customers table.';
  };
}

describe('no cell value reaches the model', () => {
  it('holds across ask, execute and explain', async () => {
    const file = seedDatabase();
    const seen: string[] = [];
    const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
    const engine = createAskSql({ connectors: [connector], model: recordingModel(seen), answerSchemaQuestions: true });

    const asked = await engine.ask('list every customer email');
    const result = await engine.execute(asked.sql);
    // The rows really did come back to the caller - so the search below is meaningful.
    expect(result.rows.flat().join(' ')).toContain(SECRETS.email);
    await engine.explain(asked.sql);

    const prompts = seen.join('\n');
    // The schema IS sent, which proves we searched real prompts rather than empty ones.
    expect(prompts).toContain('customers');
    for (const [column, value] of Object.entries(SECRETS)) {
      expect(prompts, `${column} reached the model`).not.toContain(value);
    }
    await connector.close();
  });

  it('sends sampled values only when the host opts in', async () => {
    const file = seedDatabase();
    const seen: string[] = [];
    // Both switches on: the connector samples, and the engine is allowed to pass samples through.
    const connector = new SqliteConnector({ id: 'db', name: 'Shop', file, sampleColumnValues: true });
    const engine = createAskSql({
      connectors: [connector],
      model: recordingModel(seen),
      allowDataInPrompt: true,
    });
    await engine.ask('list every customer email');
    expect(seen.join('\n')).toContain(SECRETS.email);
    await connector.close();
  });

  it('sends nothing when the connector samples but the engine does not allow it', async () => {
    const file = seedDatabase();
    const seen: string[] = [];
    const connector = new SqliteConnector({ id: 'db', name: 'Shop', file, sampleColumnValues: true });
    // The engine default is off, so sampling at the connector alone must not leak.
    const engine = createAskSql({ connectors: [connector], model: recordingModel(seen) });
    await engine.ask('list every customer email');
    expect(seen.join('\n')).not.toContain(SECRETS.email);
    await connector.close();
  });
});
