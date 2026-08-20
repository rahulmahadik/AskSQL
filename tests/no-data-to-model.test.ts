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
import { inferColumns } from '../packages/mongodb/src/introspect.js';

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

/**
 * The suite above covers SQLite only, and that is exactly how a MongoDB leak survived: a document using
 * a map put customer addresses in the COLUMN NAMES, and a name is never removed by the data opt-in -
 * `withoutSampledData` strips sampled values. Nothing here asserted on names, and nothing here ran
 * against Mongo. Both gaps are closed below, without needing a server.
 */
describe('no cell value reaches the model through a MongoDB schema', () => {
  const docs = [
    { ref: 'a', owed: { [SECRETS.email]: 120, 'bob@corp.com': 40 }, note: SECRETS.note },
    { ref: 'b', owed: { 'grace@example.com': 80 }, note: SECRETS.note },
    { ref: 'c', owed: { 'linus@example.com': 5 }, note: SECRETS.note },
  ];

  it('never puts a value in a column NAME, which no opt-in would strip', () => {
    const rendered = inferColumns(docs, false)
      .map((c) => `${c.name} ${c.dbType} ${c.comment ?? ''}`)
      .join('\n');
    // The collection IS described, which proves the search below ran against a real schema.
    expect(rendered).toContain('owed');
    for (const [field, value] of Object.entries(SECRETS)) {
      expect(rendered, `${field} reached the schema`).not.toContain(value);
    }
  });

  it('still keeps a genuine nested field, so the rule has not simply deleted everything', () => {
    const people = [
      { address: { city: 'Pune', zip: '411001' } },
      { address: { city: 'Berlin', zip: '10115' } },
      { address: { city: 'Oslo', zip: '0150' } },
    ];
    expect(inferColumns(people, false).map((c) => c.name)).toContain('address.city');
  });

  it('sends values only under the opt-in, exactly as the SQL path does', () => {
    const withOptIn = inferColumns(docs, true)
      .map((c) => (c.sampledValues ?? []).join(' '))
      .join(' ');
    expect(withOptIn).toContain(SECRETS.note);
    const without = inferColumns(docs, false)
      .map((c) => (c.sampledValues ?? []).join(' '))
      .join(' ');
    expect(without).not.toContain(SECRETS.note);
  });
});

/**
 * The suites above search prompts for values and Mongo columns for names. Neither looked at a column
 * COMMENT, which is the third channel: a derived hint is rendered into the schema exactly like a
 * declared one, so a key name that is really a username reaches the model through it.
 */
describe('no cell value reaches the model through a column comment', () => {
  function seedJson(rows: string[], sampleColumnValues: boolean): SqliteConnector {
    const file = join(mkdtempSync(join(tmpdir(), 'asksql-comment-')), 'app.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE standup (id INTEGER PRIMARY KEY, points TEXT)');
    const stmt = db.prepare('INSERT INTO standup (points) VALUES (?)');
    for (const r of rows) stmt.run(r);
    db.close();
    return new SqliteConnector({ id: 'db', name: 'Standup', file, sampleColumnValues });
  }

  // A per-user scoreboard: every key recurs on every row, so it is structurally identical to a record.
  const scoreboard = Array.from({ length: 10 }, () => JSON.stringify({ [SECRETS.name]: 3, ZZBOB: 5, ZZCAROL: 8 }));

  it('states how many keys recur, never which, by default', async () => {
    const connector = seedJson(scoreboard, false);
    await connector.connect();
    const catalog = await connector.introspect();
    await connector.close();
    const comments = catalog.tables.flatMap((t) => t.columns.map((c) => c.comment ?? '')).join(' ');
    // The column IS described, which proves the search below ran against a real hint.
    expect(comments).toContain('json_extract');
    expect(comments, 'a key that is really a username reached the schema').not.toContain(SECRETS.name);
    expect(comments).not.toContain('ZZBOB');
  });

  it('names them only once the host opts into cell values', async () => {
    const connector = seedJson(scoreboard, true);
    await connector.connect();
    const catalog = await connector.introspect();
    await connector.close();
    const comments = catalog.tables.flatMap((t) => t.columns.map((c) => c.comment ?? '')).join(' ');
    expect(comments).toContain(SECRETS.name);
  });
});
