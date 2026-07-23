/**
 * explainSchema: grounded natural-language answers about the schema (structure only,
 * no data), plus the prose grounding floor (unknownReferencesInProse).
 */
import { describe, expect, it } from 'vitest';
import { createAskSql, unknownReferencesInProse } from '../src/engine.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['shop'],
  tables: [
    {
      schema: 'shop',
      name: 'customers',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'region', dbType: 'text', nullable: true },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
    {
      schema: 'shop',
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'customer_id', dbType: 'bigint', nullable: false },
        { name: 'total_cents', dbType: 'bigint', nullable: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
  ],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
};

class FakeConnector implements Connector {
  engine = 'postgres' as const;
  dialect = POSTGRES_DIALECT;
  capabilities = {
    supportsCancel: true,
    supportsExplain: true,
    supportsSchemas: true,
    readOnlySession: true,
    supportsMatViews: true,
    supportsTriggers: true,
    supportsRoutines: true,
  };
  id = 'fake';
  name = 'Fake';
  constructor(private readonly catalog: SchemaCatalog = CATALOG) {}
  async connect() {}
  async close() {}
  async introspect() {
    return this.catalog;
  }
  async execute(): Promise<ResultSet> {
    throw new Error('explainSchema must never run a query');
  }
}

const model =
  (reply: string): CustomModel =>
  async () =>
    reply;

const seqModel = (replies: string[]): CustomModel => {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)]!;
};

describe('unknownReferencesInProse (grounding floor)', () => {
  it('passes an answer that only names real tables and columns', () => {
    const prose = 'The orders table links to customers via customer_id, and total_cents holds the amount.';
    expect(unknownReferencesInProse(prose, CATALOG)).toEqual([]);
  });

  it('flags an invented snake_case table name', () => {
    const prose = 'Join orders to the customer_history table to see past activity.';
    expect(unknownReferencesInProse(prose, CATALOG)).toContain('customer_history');
  });

  it('flags a backticked and a double-quoted invented name', () => {
    expect(unknownReferencesInProse('See `line_items` for details.', CATALOG)).toContain('line_items');
    expect(unknownReferencesInProse('Look at "audit_log".', CATALOG)).toContain('audit_log');
  });

  it('does not flag ordinary English or SQL vocabulary', () => {
    const prose = 'Each order has a primary_key and a foreign_key pointing at the customer. This is read_only.';
    expect(unknownReferencesInProse(prose, CATALOG)).toEqual([]);
  });

  it('does not flag SQL types or keywords in a DDL suggestion', () => {
    const prose = 'Run: ALTER TABLE customers ADD COLUMN loyalty `integer` `unique` `default` 0.';
    expect(unknownReferencesInProse(prose, CATALOG)).not.toContain('integer');
    expect(unknownReferencesInProse(prose, CATALOG)).not.toContain('unique');
  });

  it('accepts schema-qualified real names', () => {
    expect(unknownReferencesInProse('shop.orders references shop.customers.', CATALOG)).toEqual([]);
  });

  it('does not flag the bare schema name (real identifier)', () => {
    expect(unknownReferencesInProse('The `shop` schema holds customers and orders.', CATALOG)).toEqual([]);
  });

  it('returns nothing for an empty or nameless answer', () => {
    expect(unknownReferencesInProse('', CATALOG)).toEqual([]);
    expect(unknownReferencesInProse('This database tracks a small shop with a few tables.', CATALOG)).toEqual([]);
  });

  it('flags the invented part of a schema-qualified name', () => {
    expect(unknownReferencesInProse('See shop.audit_trail for history.', CATALOG)).toContain('audit_trail');
    expect(unknownReferencesInProse('See "shop.audit_trail" for history.', CATALOG)).toContain('shop.audit_trail');
  });

  it('is case-insensitive when flagging invented names', () => {
    expect(unknownReferencesInProse('Look at Customer_History.', CATALOG)).toContain('customer_history');
  });

  it('deduplicates a name mentioned several times', () => {
    const prose = 'The order_log holds events; order_log grows daily; see order_log.';
    expect(unknownReferencesInProse(prose, CATALOG)).toEqual(['order_log']);
  });

  it('does not flag a real column even when attributed to the wrong table', () => {
    // Conservative: total_cents is a real column, so a bare reference passes even if the
    // sentence pins it to customers. The floor catches invented names, not misattribution.
    expect(unknownReferencesInProse('customers.total_cents is the amount.', CATALOG)).toEqual([]);
  });
});

describe('engine.explainSchema', () => {
  it('returns a grounded prose answer and the tables it was given, without running a query', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model('The orders table records purchases; customer_id links each order to the customers table.'),
    });
    const res = await engine.explainSchema('How are orders and customers related?');
    expect(res.answer).toContain('orders');
    expect(res.grounded).toBe(true);
    expect(res.unknownReferences).toEqual([]);
    expect(res.tables).toEqual(expect.arrayContaining(['shop.orders', 'shop.customers']));
  });

  it('marks an answer that invents a table name as not grounded', async () => {
    const conn = new FakeConnector();
    const engine = createAskSql({
      connectors: [conn],
      model: model('Revenue lives in the monthly_totals table, joined to orders.'),
    });
    const res = await engine.explainSchema('Where is revenue stored?');
    expect(res.grounded).toBe(false);
    expect(res.unknownReferences).toContain('monthly_totals');
  });

  it('answers plainly when the connection has no readable tables', async () => {
    const empty: SchemaCatalog = { ...CATALOG, tables: [] };
    const engine = createAskSql({ connectors: [new FakeConnector(empty)], model: model('unused') });
    const res = await engine.explainSchema('what is here?');
    expect(res.tables).toEqual([]);
    expect(res.grounded).toBe(true);
    expect(res.answer.toLowerCase()).toContain('no tables');
  });

  it('repairs an ungrounded understanding answer on one retry', async () => {
    const conn = new FakeConnector();
    const m = seqModel([
      'Revenue is stored in the monthly_totals table.', // ungrounded first attempt
      'Order amounts live in the orders table, in total_cents.', // grounded retry
    ]);
    const engine = createAskSql({ connectors: [conn], model: m });
    const res = await engine.explainSchema('Where is revenue stored?');
    expect(res.grounded).toBe(true);
    expect(res.unknownReferences).toEqual([]);
    expect(res.isSchemaChange).toBe(false);
    expect(res.answer).toContain('orders');
  });

  it('treats a schema-change request as a read-only proposal - new names are not a hallucination, no retry', async () => {
    const conn = new FakeConnector();
    let calls = 0;
    const m: CustomModel = async () => {
      calls++;
      return 'To add it, run: ALTER TABLE customers ADD COLUMN loyalty_points int. AskSQL is read-only and will not run it.';
    };
    const engine = createAskSql({ connectors: [conn], model: m });
    const res = await engine.explainSchema('Add a loyalty_points column to customers');
    expect(res.isSchemaChange).toBe(true);
    expect(res.unknownReferences).toContain('loyalty_points'); // surfaced as a proposal, not silently
    expect(calls).toBe(1); // no repair retry for a change request
  });

  it('rejects an empty question', async () => {
    const engine = createAskSql({ connectors: [new FakeConnector()], model: model('x') });
    await expect(engine.explainSchema('   ')).rejects.toThrow();
  });

  it('a broad question ("how are the tables related?") gets the full catalog, not a term-pruned handful', async () => {
    // A table whose name shares no words with the question - term pruning would drop it,
    // but a whole-schema question must still see it.
    const wide: SchemaCatalog = {
      ...CATALOG,
      tables: [
        ...CATALOG.tables,
        {
          schema: 'shop',
          name: 'zzz_unrelated_widget',
          kind: 'table',
          columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
          primaryKey: ['id'],
          foreignKeys: [],
          uniques: [],
          checks: [],
          indexes: [],
          source: 'db',
        },
      ],
    };
    let seen = '';
    const capture: CustomModel = async (req) => {
      seen = req.prompt;
      return 'The orders, customers, and zzz_unrelated_widget tables make up this schema.';
    };
    const engine = createAskSql({ connectors: [new FakeConnector(wide)], model: capture });
    const res = await engine.explainSchema('How are the tables related?');
    expect(res.tables).toEqual(expect.arrayContaining(['shop.zzz_unrelated_widget']));
    expect(seen).toContain('zzz_unrelated_widget'); // full-schema text reached the model
    expect(seen).toContain('exactly 3 tables'); // explicit count so the model does not guess
  });
});
