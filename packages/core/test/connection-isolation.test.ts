/**
 * Two connections on one engine. A question against one must never be shown the other's schema,
 * and must never read its tables - including through the prose path, which builds its own prompt.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAskSql } from '@asksql/core';
import { SqliteConnector } from '@asksql/sqlite';

function makeDb(name: string, ddl: string): string {
  const file = join(mkdtempSync(join(tmpdir(), `asksql-${name}-`)), `${name}.db`);
  const db = new DatabaseSync(file);
  db.exec(ddl);
  db.close();
  return file;
}

function harness() {
  const shopFile = makeDb(
    'shop',
    'CREATE TABLE shop_orders (id INTEGER PRIMARY KEY, total INTEGER); INSERT INTO shop_orders VALUES (1,10);',
  );
  const hrFile = makeDb(
    'hr',
    'CREATE TABLE hr_employees (id INTEGER PRIMARY KEY, salary INTEGER); INSERT INTO hr_employees VALUES (1,999);',
  );
  const prompts: string[] = [];
  const shop = new SqliteConnector({ id: 'shop', name: 'Shop', file: shopFile });
  const hr = new SqliteConnector({ id: 'hr', name: 'HR', file: hrFile });
  const engine = createAskSql({
    connectors: [shop, hr],
    model: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return '```sql\nSELECT 1\n```';
    },
    answerSchemaQuestions: true,
  });
  return {
    engine,
    prompts,
    close: async () => {
      await shop.close();
      await hr.close();
    },
  };
}

describe('connections are isolated', () => {
  it('a question is only shown its own schema', async () => {
    const { engine, prompts, close } = harness();

    await engine.ask('how many orders', { connectionId: 'shop' });
    expect(prompts.join('\n')).toContain('shop_orders');
    expect(prompts.join('\n')).not.toContain('hr_employees');

    prompts.length = 0;
    await engine.ask('how many employees', { connectionId: 'hr' });
    expect(prompts.join('\n')).toContain('hr_employees');
    expect(prompts.join('\n')).not.toContain('shop_orders');

    await close();
  });

  it('the prose path is scoped the same way', async () => {
    const { engine, prompts, close } = harness();
    await engine.explainSchema('what is this database for', { connectionId: 'hr' });
    const sent = prompts.join('\n');
    expect(sent).toContain('hr_employees');
    expect(sent).not.toContain('shop_orders');
    await close();
  });

  it('one connection cannot read another connection tables', async () => {
    const { engine, close } = harness();
    await expect(engine.execute('SELECT * FROM hr_employees', { connectionId: 'shop' })).rejects.toThrow();
    await close();
  });
});
