import { describe, expect, it, vi } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { namesSomethingInCatalog } from '../src/schema-match.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, SchemaCatalog } from '../src/types.js';

const table = (name: string, cols: string[]) => ({
  name,
  kind: 'table',
  columns: cols.map((c) => ({ name: c, dbType: 'text', nullable: true })),
  primaryKey: [],
  foreignKeys: [],
  uniques: [],
  checks: [],
  indexes: [],
  source: 'db',
});

const catalogOf = (...tables: unknown[]) =>
  ({
    engine: 'postgres',
    schemas: [],
    tables,
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: 'now',
  }) as unknown as SchemaCatalog;

const customersOnly = catalogOf(table('customers', ['CustomerId', 'Name']));

describe('namesSomethingInCatalog', () => {
  it.each([
    'how many customers are there?',
    'list the names',
    'show me every customer',
    'what is the CustomerId of Ada?',
  ])('recognises %s', (question) => {
    expect(namesSomethingInCatalog(question, customersOnly)).toBe(true);
  });

  /** These name a relation the catalog has never heard of, which is the stale case. */
  it.each(['how many invoices are there?', 'show me the shipments', 'total revenue per warehouse'])(
    'does not recognise %s',
    (question) => {
      expect(namesSomethingInCatalog(question, customersOnly)).toBe(false);
    },
  );

  it('says yes when there is nothing to match against, since a refresh would not help', () => {
    expect(namesSomethingInCatalog('anything at all', catalogOf())).toBe(true);
  });
});

describe('a table added after the catalog was read', () => {
  /**
   * The failure this prevents is silent: asked for invoices with only customers cached, a model
   * counts customers and reports a number, so the user is told the wrong thing with no error.
   */
  it('re-reads the catalog rather than answering about a different table', async () => {
    let hasInvoices = false;
    const introspect = vi.fn(async () =>
      hasInvoices ? catalogOf(table('customers', ['Name']), table('invoices', ['Total'])) : customersOnly,
    );
    const conn = {
      engine: 'postgres',
      dialect: POSTGRES_DIALECT,
      capabilities: {},
      id: 'db',
      name: 'DB',
      async connect() {},
      async close() {},
      introspect,
      async execute() {
        return { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1, warnings: [] };
      },
    } as unknown as Connector;

    // Answers whichever table the question names, the way a model would.
    const model = (async ({ prompt }: { prompt: string }) =>
      `\`\`\`sql\nSELECT COUNT(*) FROM ${/invoice/i.test(prompt) ? 'invoices' : 'customers'}\n\`\`\``) as unknown as CustomModel;
    const engine = createAskSql({ connectors: [conn], model });

    await engine.ask('how many customers are there?'); // caches a catalog without invoices
    hasInvoices = true;
    const answer = await engine.ask('how many invoices are there?');

    expect(answer.sql).toContain('invoices');
    expect(introspect.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not re-read for a question the catalog already covers', async () => {
    const introspect = vi.fn(async () => customersOnly);
    const conn = {
      engine: 'postgres',
      dialect: POSTGRES_DIALECT,
      capabilities: {},
      id: 'db',
      name: 'DB',
      async connect() {},
      async close() {},
      introspect,
      async execute() {
        return { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1, warnings: [] };
      },
    } as unknown as Connector;
    const model = (async () => '```sql\nSELECT COUNT(*) FROM customers\n```') as unknown as CustomModel;
    const engine = createAskSql({ connectors: [conn], model });

    await engine.ask('how many customers are there?');
    await engine.ask('list the customer names');

    expect(introspect).toHaveBeenCalledTimes(1);
  });
});
