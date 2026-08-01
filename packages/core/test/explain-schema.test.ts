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

describe('scope: only databases and data', () => {
  it('turns the out-of-scope sentinel into an honest decline naming the engine, not the raw sentinel', async () => {
    const engine = createAskSql({ connectors: [new FakeConnector()], model: model('OUT_OF_SCOPE') });
    const res = await engine.explainSchema('Tell me a joke about penguins');
    expect(res.answer).not.toContain('OUT_OF_SCOPE');
    expect(res.answer).toMatch(/only help with databases/i);
    expect(res.answer).toMatch(/PostgreSQL/i);
    expect(res.grounded).toBe(true);
    expect(res.tables).toEqual([]);
  });

  // A refusal is only accepted when the QUESTION gives no sign of being about this database.
  // Naming a real table is that sign, and it survives phrasing a keyword list would miss - which
  // is the difference between helping someone with imperfect English and refusing them.
  it('challenges a refusal when the question names a real table, however it is worded', async () => {
    const engine = createAskSql({
      connectors: [new FakeConnector()],
      model: seqModel(['OUT_OF_SCOPE', 'Removing cancelled rows from shop.orders is a delete on that table.']),
    });
    const res = await engine.explainSchema('delet the cancel order in orders pls');
    expect(res.answer).not.toMatch(/only help with databases/i);
    expect(res.answer).toMatch(/shop\.orders/);
  });

  it('still declines when the question names nothing in the database and reads as small talk', async () => {
    const engine = createAskSql({
      connectors: [new FakeConnector()],
      model: seqModel(['OUT_OF_SCOPE', 'OUT_OF_SCOPE']),
    });
    expect((await engine.explainSchema('tell me a joke about penguins')).answer).toMatch(/only help with databases/i);
  });

  it('accepts the sentinel when a model wraps it in punctuation or a short apology', async () => {
    const engine = createAskSql({ connectors: [new FakeConnector()], model: model('Sorry - OUT_OF_SCOPE.') });
    expect((await engine.explainSchema('what is the weather today?')).answer).toMatch(/only help with databases/i);
  });

  it('leaves a normal schema answer alone (the guard only fires on the sentinel)', async () => {
    const engine = createAskSql({
      connectors: [new FakeConnector()],
      model: model('The orders table records purchases, linked to customers by customer_id.'),
    });
    expect((await engine.explainSchema('what is in this database?')).answer).toMatch(/orders table/i);
  });

  it('tells the model the connection engine and that other systems are answered in its terms', async () => {
    let seen = '';
    const capture: CustomModel = async (req) => {
      seen ||= req.system ?? ''; // the FIRST prompt; a retry deliberately drops the sentinel
      return 'This connection is PostgreSQL; the orders table records purchases.';
    };
    await createAskSql({ connectors: [new FakeConnector()], model: capture }).explainSchema('is this mysql?');
    expect(seen).toMatch(/this connection is PostgreSQL/i);
    expect(seen).toContain('OUT_OF_SCOPE');
  });
});

describe('grounding floor: aliases and change requests', () => {
  it('does not flag a name the answer itself defines with AS in a query', () => {
    const prose = 'Use SELECT count(*) AS customer_count FROM shop.customers to count them.';
    expect(unknownReferencesInProse(prose, CATALOG)).toEqual([]);
  });

  it('still flags an invented table alongside a legitimate alias', () => {
    const prose = 'SELECT sum(total) AS revenue_total FROM shop.monthly_rollup';
    expect(unknownReferencesInProse(prose, CATALOG)).toEqual(['monthly_rollup']);
  });

  // The whitelist must not become a hole: English "as" is not an alias definition.
  it.each([
    ['such as', 'Join to another table, such as customer_history, for more detail.', 'customer_history'],
    ['known as', 'There is a rollup table known as monthly_totals.', 'monthly_totals'],
    ['referred to as', 'The staging area, referred to as import_buffer, holds new rows.', 'import_buffer'],
  ])('flags a hallucinated name introduced in prose with "%s"', (_label, prose, expected) => {
    expect(unknownReferencesInProse(prose, CATALOG)).toContain(expected);
  });

  it('whitelists an alias inside a fenced query too', () => {
    const answer = 'Try:\n```sql\nSELECT count(*) AS n FROM shop.customers\n```';
    expect(unknownReferencesInProse(answer, CATALOG)).toEqual([]);
  });

  it('retries a write request the model wrongly refused, instead of declining it', async () => {
    let call = 0;
    const refuseThenAnswer: CustomModel = async () =>
      ++call === 1 ? 'OUT_OF_SCOPE' : '```sql\nDELETE FROM shop.orders WHERE placed_at < \'2020-01-01\';\n```';
    const engine = createAskSql({ connectors: [new FakeConnector()], model: refuseThenAnswer });
    const res = await engine.explainSchema('Write a DELETE removing everything older than 2020');
    expect(call).toBe(2); // challenged once, then answered - no grounding repair, since a proposal may name new things
    expect(res.answer).not.toMatch(/only help with databases/i);
    expect(res.answer).toMatch(/never executes statements/i); // still carries the read-only note
  });

  it('accepts a refusal the model repeats when challenged', async () => {
    const engine = createAskSql({ connectors: [new FakeConnector()], model: model('OUT_OF_SCOPE') });
    const res = await engine.explainSchema('Write a poem about the sea');
    expect(res.answer).toMatch(/only help with databases/i);
  });
});

describe('scope guard: a model that refuses in prose', () => {
  it('gives the canned decline when the challenged retry still refuses, not a bare apology', async () => {
    let call = 0;
    const refuseTwice: CustomModel = async () =>
      ++call === 1 ? 'OUT_OF_SCOPE' : "I'm sorry, but I can't assist with that request.";
    const engine = createAskSql({ connectors: [new FakeConnector()], model: refuseTwice });
    const res = await engine.explainSchema('delete my Spotify listening history');
    expect(call).toBe(2);
    expect(res.answer).toMatch(/only help with databases/i);
    expect(res.answer).not.toMatch(/i'm sorry/i);
  });

  it('keeps a real answer that merely contains an apologetic aside', async () => {
    let call = 0;
    const model2: CustomModel = async () =>
      ++call === 1 ? 'OUT_OF_SCOPE' : 'The orders table records purchases; customer_id links it to customers.';
    const engine = createAskSql({ connectors: [new FakeConnector()], model: model2 });
    const res = await engine.explainSchema('how do these tables relate?');
    expect(res.answer).toMatch(/orders table/i);
  });
});

describe('scope guard: a reply that is not an answer', () => {
  // Live failure on Oracle: the schema contained OUT_ARGUMENT, and a 7B model asked an
  // off-topic question replied "OUT_ARGUMENT VARCHAR2" - the sentinel autocompleted into
  // schema vocabulary, and the fragment was shown to the user as the answer.
  it.each([
    ['a schema fragment', 'OUT_ARGUMENT VARCHAR2'],
    ['a reformatted sentinel', 'OUT OF SCOPE'],
    ['a bare column name', 'id bigint'],
  ])('replaces %s with the decline instead of showing it', async (_label, reply) => {
    const engine = createAskSql({ connectors: [new FakeConnector()], model: model(reply) });
    const res = await engine.explainSchema('who won the world cup in 2022?');
    expect(res.answer).toMatch(/only help with databases/i);
    expect(res.answer).not.toContain(reply);
  });

  it('leaves a short but real sentence alone', async () => {
    const engine = createAskSql({
      connectors: [new FakeConnector()],
      model: model('Orders link to customers by customer_id.'),
    });
    expect((await engine.explainSchema('how do these relate?')).answer).toMatch(/orders link to customers/i);
  });
});

describe('scope guard: an answer is not a refusal', () => {
  // The bound alone threw away real answers: an explanation that says what the schema cannot
  // tell you is still an explanation, and it names real tables.
  it('keeps an answer that hedges with "I can\'t tell from the schema"', async () => {
    let call = 0;
    const m: CustomModel = async () =>
      ++call === 1
        ? 'OUT_OF_SCOPE'
        : "Join shop.orders to shop.customers on customer_id. I can't tell from the schema alone whether every order has a customer, since the column is nullable.";
    const res = await createAskSql({ connectors: [new FakeConnector()], model: m }).explainSchema(
      'how would I do this in MongoDB?',
    );
    expect(res.answer).toMatch(/join shop.orders/i);
    expect(res.answer).not.toMatch(/only help with databases/i);
  });

  it('still declines when the retry refuses without naming anything real', async () => {
    let call = 0;
    const m: CustomModel = async () => (++call === 1 ? 'OUT_OF_SCOPE' : "I'm sorry, but I can't assist with that.");
    const res = await createAskSql({ connectors: [new FakeConnector()], model: m }).explainSchema(
      'delete my Spotify history',
    );
    expect(res.answer).toMatch(/only help with databases/i);
  });

  // A reply that OPENS with the marker is a refusal, however much the model then rambles.
  it('declines when the reply leads with the sentinel, whatever follows it', async () => {
    const long =
      'OUT_OF_SCOPE. Actually, the orders table records purchases and customer_id links each order to the customers table, which is what you asked about.';
    const res = await createAskSql({ connectors: [new FakeConnector()], model: model(long) }).explainSchema(
      'how do these tables relate?',
    );
    expect(res.answer).toMatch(/only help with databases/i);
    expect(res.answer).not.toMatch(/OUT[_\s-]OF[_\s-]SCOPE/i);
  });

  // Buried mid-answer it is model noise, not a verdict: keep the answer, drop the marker.
  it('strips a sentinel the model bolts onto the middle of a real answer', async () => {
    const long =
      'The orders table records purchases, and customer_id links each order to the customers table. ' +
      'OUT_OF_SCOPE was not needed here, since this is a schema question about real tables.';
    const res = await createAskSql({ connectors: [new FakeConnector()], model: model(long) }).explainSchema(
      'how do these tables relate?',
    );
    expect(res.answer).not.toMatch(/OUT[_\s-]OF[_\s-]SCOPE/i);
    expect(res.answer).toMatch(/orders table records purchases/i);
  });
});

// The marker is snake_case, so grounding must never see it: reporting `out_of_scope` as an
// invented name marks a correct answer ungrounded and burns a repair round-trip.
it('does not report the stripped marker as an invented name', async () => {
  const long =
    'The shop.orders table records purchases and is the main fact table in this small schema, ' +
    'with one row per order placed by a customer. OUT_OF_SCOPE';
  const res = await createAskSql({ connectors: [new FakeConnector()], model: model(long) }).explainSchema(
    'what is orders for?',
  );
  expect(res.unknownReferences).toEqual([]);
  expect(res.grounded).toBe(true);
  expect(res.answer).not.toMatch(/OUT[_\s-]OF[_\s-]SCOPE/i);
});

/**
 * The read-only note is the only thing standing between a model-written DELETE and a user who
 * runs it by hand. These pin the SHAPES, because a fenced ```sql block alone would also pass
 * against the old fence-only check and prove nothing about the current one.
 */
describe('the read-only note attaches by statement shape', () => {
  const propose = async (reply: string) =>
    (await createAskSql({ connectors: [new FakeConnector()], model: model(reply) }).explainSchema(
      'write me a statement for that',
    )).answer;

  it.each([
    ['a bare DELETE with no code fence', 'DELETE FROM shop.orders WHERE placed_at < 2020;'],
    ['a bare UPDATE with an alias', 'UPDATE shop.orders o SET status = 1 WHERE o.id = 2;'],
    ['a bare INSERT', 'INSERT INTO shop.orders (id) VALUES (1);'],
    ['TRUNCATE without the TABLE keyword', 'TRUNCATE shop.orders;'],
    ['CREATE TYPE', 'CREATE TYPE order_status AS ENUM (\'new\');'],
    ['COMMENT ON', "COMMENT ON COLUMN shop.orders.id IS 'the id';"],
    ['GRANT', 'GRANT SELECT ON shop.orders TO analyst;'],
    ['a fenced DROP', '```sql\nDROP TABLE shop.orders;\n```'],
  ])('adds it to %s', async (_label, reply) => {
    expect(await propose(reply)).toMatch(/never executes statements/i);
  });

  it.each([
    ['prose that merely mentions updating', 'You can update the row later; the orders table stores it.'],
    ['prose starting with Truncate', 'Truncate the discussion here - the orders table is the answer.'],
    ['a SELECT', 'Use SELECT * FROM shop.orders to see them.'],
  ])('does not add it to %s', async (_label, reply) => {
    expect(await propose(reply)).not.toMatch(/never executes statements/i);
  });
});

/**
 * A 1.5B model ignores the sentinel rule and answers the joke. Scope cannot depend on the model
 * following instructions, so the last word is code: a question with no database vocabulary,
 * answered without naming anything in the catalog, is not a database answer.
 */
describe('scope backstop for models that ignore the rule', () => {
  it('declines when the model answers an off-topic question outright', async () => {
    const joke = "Sure, here's a joke about penguins: why did the penguin go to the doctor? It had a belly ache.";
    const res = await createAskSql({ connectors: [new FakeConnector()], model: model(joke) }).explainSchema(
      'Tell me a joke about penguins',
    );
    expect(res.answer).toMatch(/only help with databases/i);
    expect(res.answer).not.toMatch(/penguin/i);
  });

  it('keeps an answer to a vocabulary-free question that does describe the schema', async () => {
    const real = 'The orders table records purchases, and customer_id links each one to customers.';
    const res = await createAskSql({ connectors: [new FakeConnector()], model: model(real) }).explainSchema(
      'what is this for?',
    );
    expect(res.answer).toMatch(/orders table records purchases/i);
  });

  it('keeps a general database answer that names no table, because the question is about databases', async () => {
    const general = 'An index speeds up lookups at the cost of slower writes; add one for a column you filter on often.';
    const res = await createAskSql({ connectors: [new FakeConnector()], model: model(general) }).explainSchema(
      'what is a database index and when should I add one?',
    );
    expect(res.answer).toMatch(/speeds up lookups/i);
  });
});
