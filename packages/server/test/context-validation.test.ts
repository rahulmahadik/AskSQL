/**
 * Prior turns come from the client, so they are untrusted. A junk entry must not 500, must not
 * bloat the prompt, and above all must not relax the off-topic guard - one `[{}]` used to turn
 * /explainSchema into a general-purpose model proxy.
 */
import { describe, expect, it } from 'vitest';
import { AskSqlServer } from '../src/index.js';
import type { Connector, ServerRequest } from '../src/index.js';

function harness() {
  const prompts: string[] = [];
  const connector = {
    id: 'db',
    name: 'Shop',
    engine: 'postgres',
    dialect: { engine: 'postgres', grammar: 'postgresql', promptLabel: 'PostgreSQL', promptNotes: [] },
    capabilities: {},
    connect: async () => {},
    close: async () => {},
    introspect: async () => ({
      engine: 'postgres' as const,
      schemas: ['shop'],
      tables: [
        {
          name: 'orders',
          schema: 'shop',
          kind: 'table' as const,
          columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
          primaryKey: ['id'],
          foreignKeys: [],
          uniques: [],
          checks: [],
          indexes: [],
          source: 'db' as const,
        },
      ],
      enums: [],
      sequences: [],
      triggers: [],
      routines: [],
      warnings: [],
      fetchedAt: 'now',
    }),
    query: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0, warnings: [] }),
  } as unknown as Connector;

  const server = new AskSqlServer({
    connectors: [connector],
    engine: {
      model: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        // The model plays along with anything, so only the guard can refuse.
        return 'Penguins are birds that cannot fly.';
      },
      answerSchemaQuestions: true,
    },
    auth: () => ({ userId: 'u', allowedConnectionIds: ['db'] }),
  });

  const post = (path: string, body: unknown) =>
    server.handle({
      method: 'POST',
      path,
      query: {},
      headers: { 'content-type': 'application/json' },
      json: async () => body,
    } as unknown as ServerRequest);

  return { post, prompts };
}

describe('client-supplied context is validated', () => {
  const JUNK = [
    ['an empty object', [{}]],
    ['a null entry', [null]],
    ['a string instead of an array', 'not an array'],
    ['an entry with no sql', [{ question: 'hi' }]],
    ['an entry whose sql is blank', [{ question: 'hi', sql: '   ' }]],
    ['a number', 42],
  ] as const;

  for (const [label, context] of JUNK) {
    it(`does not crash on ${label}`, async () => {
      const { post } = harness();
      const res = await post('/explainSchema', { connectionId: 'db', question: 'tell me a joke', context });
      // Whatever happens, it must not be a server error.
      expect(res.status).toBeLessThan(500);
    });

    it(`does not let ${label} relax the off-topic guard`, async () => {
      const { post } = harness();
      const res = await post('/explainSchema', {
        connectionId: 'db',
        question: 'tell me a joke about penguins',
        context,
      });
      const answer = String((res.body as { answer?: string } | undefined)?.answer ?? '');
      expect(answer, 'an off-topic question must still be declined').toMatch(/only help with databases/i);
    });
  }

  it('a real prior turn still reaches the prompt', async () => {
    const { post, prompts } = harness();
    await post('/explainSchema', {
      connectionId: 'db',
      question: 'explain this query to me',
      context: [{ question: 'count orders', sql: 'SELECT count(*) FROM shop.orders' }],
    });
    expect(prompts.join('\n')).toContain('SELECT count(*) FROM shop.orders');
  });

  it('caps how many turns and how much text a client can push into the prompt', async () => {
    const { post, prompts } = harness();
    const context = Array.from({ length: 40 }, (_, i) => ({ question: `q${i}`, sql: `SELECT ${i} FROM shop.orders` }));
    await post('/explainSchema', { connectionId: 'db', question: 'explain this query to me', context });
    const sent = prompts.join('\n');
    expect(sent).not.toContain('SELECT 0 FROM');
    expect(sent).toContain('SELECT 39 FROM');
  });
});
