/**
 * An integer status column carries no meaning in the database: what 1 means lives in the application.
 * So the model picks an ordinal, and a wrong pick matches no row - the zero that comes back is
 * indistinguishable from a true zero. Measured on the Room fixture: "How many orders are paid?" wrote
 * `status = 2`, returned 0, truth 2.
 *
 * The values are read from the database and kept local. Naming them to the model is row data, which
 * only `allowDataInPrompt` permits, so the default carries a caveat instead of repairing.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAskSql } from '@asksql/core';
import { SqliteConnector } from '@asksql/sqlite';

/** Statuses present are 0, 1 and 3. Nothing holds 2, which is the ordinal a model tends to guess. */
function seedDatabase(extra = ''): string {
  const file = join(mkdtempSync(join(tmpdir(), 'asksql-codes-')), 'app.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY, status INTEGER);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY, user_id INTEGER, status INTEGER, total_cents INTEGER, placed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    INSERT INTO users VALUES (1, 'Ada'), (2, 'Grace');
    INSERT INTO orders VALUES (1, 1, 0, 500, 1755300000000), (2, 1, 1, 900, 1755300000001),
      (3, 2, 1, 250, 1755300000002), (4, 2, 3, 1999, 1755300000003);
    ${extra}
  `);
  db.close();
  return file;
}

/** Answers with `sql` every time, and records what it was told. */
function fixedModel(sql: string, seen: string[] = []) {
  const model = async ({ system, prompt }: { system: string; prompt: string }): Promise<string> => {
    seen.push(system, prompt);
    return `\`\`\`sql\n${sql}\n\`\`\`\nA query.`;
  };
  return model;
}

async function askWith(sql: string, opts: { allowDataInPrompt?: boolean } = {}, seen: string[] = []) {
  const file = seedDatabase();
  const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
  const engine = createAskSql({ connectors: [connector], model: fixedModel(sql, seen), ...opts });
  const asked = await engine.ask('how many orders are paid?');
  const warnings = asked.guard.warnings.join(' ');
  await connector.close();
  return { sql: asked.sql, warnings, prompts: seen.join('\n') };
}

describe('a code no row holds is reported rather than answered', () => {
  it('caveats a status the table does not have', async () => {
    const { warnings } = await askWith('SELECT COUNT(*) FROM orders WHERE status = 2');
    expect(warnings).toContain('orders.status = 2');
    expect(warnings).toMatch(/defined in the application/i);
  });

  it('says nothing when the code does exist', async () => {
    const { warnings } = await askWith('SELECT COUNT(*) FROM orders WHERE status = 1');
    expect(warnings).not.toMatch(/status/i);
  });

  it('says nothing about an identifier, where an absent value is an ordinary empty result', async () => {
    for (const sql of [
      'SELECT * FROM orders WHERE id = 99',
      'SELECT * FROM orders WHERE user_id = 99',
      'SELECT * FROM users WHERE id = 99',
    ]) {
      const { warnings } = await askWith(sql);
      expect(warnings, sql).not.toMatch(/no row has/i);
    }
  });

  it('says nothing about a moment compared with an epoch bound', async () => {
    const { warnings } = await askWith('SELECT * FROM orders WHERE placed_at = 1755300000009');
    expect(warnings).not.toMatch(/no row has/i);
  });

  it('says nothing about a column with too many distinct values to be a code', async () => {
    // total_cents is a measurement: an absent amount is a real answer, not a guess.
    const file = seedDatabase(
      `INSERT INTO orders (user_id, status, total_cents, placed_at)
       SELECT 1, 1, value, 1755300000000 FROM (WITH RECURSIVE n(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 60) SELECT value FROM n);`,
    );
    const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
    const engine = createAskSql({
      connectors: [connector],
      model: fixedModel('SELECT * FROM orders WHERE total_cents = 777777'),
    });
    const asked = await engine.ask('orders costing 777777');
    expect(asked.guard.warnings.join(' ')).not.toMatch(/no row has/i);
    await connector.close();
  });
});

describe('the values stay out of the prompt unless the host opts in', () => {
  it('never names them by default, and caveats instead', async () => {
    const seen: string[] = [];
    const { prompts, warnings, sql } = await askWith('SELECT COUNT(*) FROM orders WHERE status = 2', {}, seen);
    // The schema IS sent, which proves the search below ran against real prompts.
    expect(prompts).toContain('orders');
    expect(prompts).not.toMatch(/values it actually holds/i);
    // The caveat is for the reader; the wrong SQL is left as the model wrote it.
    expect(warnings).toContain('orders.status = 2');
    expect(sql).toContain('status = 2');
  });

  it('names them in a repair only when data in the prompt is allowed', async () => {
    const seen: string[] = [];
    await askWith('SELECT COUNT(*) FROM orders WHERE status = 2', { allowDataInPrompt: true }, seen);
    const prompts = seen.join('\n');
    expect(prompts).toMatch(/No row has orders\.status = 2/);
    expect(prompts).toMatch(/values it actually holds are: 0, 1, 3/);
  });
});

/**
 * A fixed-scale numeric renders 18 as "18.00". Comparing the probe's text to the literal's text reported
 * the value as absent while the very query it came from was returning rows, so a correct answer carried
 * a caveat saying no row had it. Measured on Postgres NUMERIC(5,2); SQLite normalises 18.00 to 18 and
 * cannot reproduce it, so the probe's rendering is substituted here.
 */
describe('a value present in a fixed-scale numeric column is never called absent', () => {
  async function askWithProbeReturning(distinct: string[], sql: string) {
    const file = seedDatabase();
    const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
    const real = connector.execute.bind(connector);
    connector.execute = (async (query: string, opts?: unknown) => {
      if (/^SELECT DISTINCT/i.test(query.trim())) {
        return {
          columns: [{ name: 'v', dbType: 'numeric' }],
          rows: distinct.map((v) => [v]),
          rowCount: distinct.length,
          truncated: false,
          durationMs: 0,
          warnings: [],
        };
      }
      return real(query, opts as never);
    }) as typeof connector.execute;

    const engine = createAskSql({ connectors: [connector], model: fixedModel(sql) });
    const asked = await engine.ask('how many?');
    const warnings = asked.guard.warnings.join(' ');
    await connector.close();
    return warnings;
  }

  it('says nothing when the literal matches a scaled rendering of the same number', async () => {
    const warnings = await askWithProbeReturning(
      ['18.00', '5.00', '0.00'],
      'SELECT COUNT(*) FROM orders WHERE status = 18',
    );
    expect(warnings).not.toMatch(/no row has/i);
  });

  it('still reports a literal the column genuinely does not hold', async () => {
    const warnings = await askWithProbeReturning(
      ['18.00', '5.00', '0.00'],
      'SELECT COUNT(*) FROM orders WHERE status = 7',
    );
    expect(warnings).toMatch(/No row has orders\.status = 7/);
  });
});

/**
 * The caveat says the query returned nothing BECAUSE of this value, so it may only be attached when the
 * comparison decides the result. Under OR, NOT, CASE or a partial IN the query returns rows, and the
 * caveat was contradicting the answer beside it; with the data opt-in the repair rewrote a correct query.
 */
describe('only a literal that decides the result is reported', () => {
  it('says nothing when another branch of an OR can still match', async () => {
    const { warnings } = await askWith('SELECT COUNT(*) FROM orders WHERE status = 2 OR total_cents > 1');
    expect(warnings).not.toMatch(/no row has/i);
  });

  it('says nothing about a conditional aggregate', async () => {
    const { warnings } = await askWith('SELECT SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) FROM orders');
    expect(warnings).not.toMatch(/no row has/i);
  });

  it('says nothing when the comparison is negated', async () => {
    const { warnings } = await askWith('SELECT * FROM orders WHERE NOT (status = 2)');
    expect(warnings).not.toMatch(/no row has/i);
  });

  it('says nothing about an IN list that holds a real value', async () => {
    const { warnings } = await askWith('SELECT COUNT(*) FROM orders WHERE status IN (0,2)');
    expect(warnings).not.toMatch(/no row has/i);
  });

  it('still reports it inside an AND, where it does decide', async () => {
    const { warnings } = await askWith('SELECT COUNT(*) FROM orders WHERE status = 2 AND total_cents > 1');
    expect(warnings).toContain('orders.status = 2');
  });

  it('never probes a view, whose read runs its query', async () => {
    // Every other probe in the hint work excludes views for that reason; this one did not.
    const file = seedDatabase('CREATE VIEW v_orders AS SELECT status FROM orders;');
    const connector = new SqliteConnector({ id: 'db', name: 'Shop', file });
    const engine = createAskSql({
      connectors: [connector],
      model: fixedModel('SELECT COUNT(*) FROM v_orders WHERE status = 2'),
    });
    const asked = await engine.ask('how many?');
    expect(asked.guard.warnings.join(' ')).not.toMatch(/no row has/i);
    await connector.close();
  });

  it('resolves the column when another table shares its name', async () => {
    // Judged against the whole catalog, `status` on two tables made every reference ambiguous and the
    // check went silent on any real schema.
    const { warnings } = await askWith('SELECT COUNT(*) FROM orders o WHERE o.status = 2');
    expect(warnings).toContain('orders.status = 2');
  });
});
