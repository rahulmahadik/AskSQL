/**
 * Full question-routing matrix: every engine x every question shape, against real databases and a
 * real model. Proves the three routes stay apart (data -> SQL, advice -> prose, write -> proposal)
 * and that nothing in the run writes to any database.
 *
 * Run: node tools/e2e-matrix.mjs [engine...]        (default: every engine that is reachable)
 * Env: ASKSQL_PROVIDER (default ollama), ASKSQL_MODEL / ASKSQL_OLLAMA_MODEL, ASKSQL_API_KEY,
 *      ASKSQL_BASE_URL. The routing has to hold on a hosted model as well as a local one.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Relative to dist, not by package name: only some of these are dependencies of the workspace root,
// and this script has to load every one of them.
const { createAskSql, resolveModel } = await import('../packages/core/dist/index.js');
const { createMongoAskSql } = await import('../packages/core/dist/mongo/index.js');
const { PostgresConnector } = await import('../packages/postgres/dist/index.js');
const { MysqlConnector } = await import('../packages/mysql/dist/index.js');
const { SqliteConnector } = await import('../packages/sqlite/dist/index.js');
const { DuckDbConnector } = await import('../packages/duckdb/dist/index.js');
const { MongodbConnector } = await import('../packages/mongodb/dist/index.js');

const PROVIDER = process.env.ASKSQL_PROVIDER ?? 'ollama';
const MODEL = process.env.ASKSQL_MODEL ?? process.env.ASKSQL_OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
const scratch = mkdtempSync(join(tmpdir(), 'asksql-e2e-'));

/** Every engine, with a fixture small enough that a 3B model can hold it. */
async function engines() {
  const sqlitePath = join(scratch, 'shop.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, region TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id),
                         status TEXT NOT NULL, total_cents INTEGER NOT NULL);
    INSERT INTO customers (email, region) VALUES ('a@x.com','EU'),('b@x.com','NA');
    INSERT INTO orders (customer_id, status, total_cents) VALUES (1,'paid',500),(1,'cancelled',100),(2,'paid',900);
  `);
  db.close();

  const csv = join(scratch, 'orders.csv');
  writeFileSync(csv, 'status,total_cents\npaid,500\ncancelled,100\npaid,900\n');

  // A schema big enough that pruning and join-path reasoning are actually exercised.
  const bigPath = join(scratch, 'big.db');
  const big = new DatabaseSync(bigPath);
  big.exec(`
    CREATE TABLE regions (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL);
    CREATE TABLE warehouses (id INTEGER PRIMARY KEY, region_id INTEGER REFERENCES regions(id), code TEXT NOT NULL);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region_id INTEGER REFERENCES regions(id));
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER REFERENCES categories(id));
    CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT NOT NULL, category_id INTEGER REFERENCES categories(id),
                           supplier_id INTEGER REFERENCES suppliers(id), price_cents INTEGER NOT NULL);
    CREATE TABLE inventory (product_id INTEGER REFERENCES products(id), warehouse_id INTEGER REFERENCES warehouses(id),
                            qty INTEGER NOT NULL, PRIMARY KEY (product_id, warehouse_id));
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, region_id INTEGER REFERENCES regions(id),
                            created_at TEXT NOT NULL);
    CREATE TABLE addresses (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), line1 TEXT, city TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id),
                         warehouse_id INTEGER REFERENCES warehouses(id), status TEXT NOT NULL,
                         placed_at TEXT NOT NULL, total_cents INTEGER NOT NULL);
    CREATE TABLE order_items (order_id INTEGER REFERENCES orders(id), product_id INTEGER REFERENCES products(id),
                              qty INTEGER NOT NULL, unit_cents INTEGER NOT NULL, PRIMARY KEY (order_id, product_id));
    CREATE TABLE shipments (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), carrier TEXT, shipped_at TEXT);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), method TEXT, amount_cents INTEGER);
    CREATE TABLE refunds (id INTEGER PRIMARY KEY, payment_id INTEGER REFERENCES payments(id), amount_cents INTEGER, reason TEXT);
    CREATE TABLE reviews (id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id),
                          customer_id INTEGER REFERENCES customers(id), rating INTEGER, body TEXT);
    CREATE TABLE promotions (id INTEGER PRIMARY KEY, code TEXT NOT NULL, discount_pct INTEGER);
    CREATE TABLE order_promotions (order_id INTEGER REFERENCES orders(id), promotion_id INTEGER REFERENCES promotions(id),
                                   PRIMARY KEY (order_id, promotion_id));
    INSERT INTO regions (name, country) VALUES ('EU','DE'),('NA','US');
    INSERT INTO customers (email, region_id, created_at) VALUES ('a@x.com',1,'2026-01-01'),('b@x.com',2,'2026-02-01');
    INSERT INTO warehouses (region_id, code) VALUES (1,'W-EU'),(2,'W-NA');
    INSERT INTO orders (customer_id, warehouse_id, status, placed_at, total_cents)
      VALUES (1,1,'paid','2026-03-01',500),(1,1,'cancelled','2026-03-02',100),(2,2,'paid','2026-03-03',900);
  `);
  big.close();

  return [
    {
      name: 'postgres',
      make: () =>
        new PostgresConnector({
          id: 'db',
          name: 'Shop',
          host: '127.0.0.1',
          port: 5432,
          user: 'postgres',
          password: 'root',
          database: 'postgres',
        }),
    },
    {
      name: 'mysql',
      make: () =>
        new MysqlConnector({
          id: 'db',
          name: 'Shop',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
          database: 'asksql_e2e',
        }),
    },
    { name: 'sqlite', make: () => new SqliteConnector({ id: 'db', name: 'Shop', file: sqlitePath }) },
    { name: 'bigschema', big: true, make: () => new SqliteConnector({ id: 'db', name: 'Warehouse', file: bigPath }) },
    {
      name: 'duckdb',
      make: () => new DuckDbConnector({ id: 'db', name: 'Files', files: [{ path: csv, table: 'orders' }] }),
    },
    {
      name: 'mongodb',
      mongo: true,
      make: () =>
        new MongodbConnector({
          id: 'db',
          name: 'Shop',
          connectionString: 'mongodb://127.0.0.1:27017/',
          database: 'asksql_e2e',
        }),
    },
  ];
}

const out = [];
const record = (engine, name, pass, detail) => {
  out.push({ engine, name, pass });
  const head = `${pass ? 'PASS' : 'FAIL'}  [${engine}] ${name}`;
  console.log(pass ? head : `${head}\n      ${String(detail).replace(/\n/g, ' ').slice(0, 260)}`);
};

/** ask(), falling back to the prose path exactly as every host does. */
async function route(engine, question) {
  try {
    const res = await engine.ask(question);
    return { kind: 'sql', sql: res.sql ?? res.pipelineJson, explanation: res.explanation ?? '' };
  } catch (err) {
    const code = err?.code;
    if (code === 'LLM_BAD_OUTPUT' || code === 'LLM_REFUSAL') {
      const sa = await engine.explainSchema(question);
      return { kind: 'prose', answer: sa.answer, isSchemaChange: sa.isSchemaChange };
    }
    return { kind: 'error', code, message: err?.userMessage ?? String(err) };
  }
}

const CATALOG_RE = /information_schema|sqlite_master|all_tables|listCollections|show tables/i;

/**
 * Advice that degenerated into a catalog listing: the answer IS a catalog query and little else.
 * A rich answer that suggests `SELECT ... FROM sqlite_master` as one diagnostic among several is
 * good advice, not the failure this guards against - so the prose around the fences is what counts.
 */
function isCatalogListing(text) {
  if (!CATALOG_RE.test(text)) return false;
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return prose.length < 200;
}

async function runEngine(spec, model) {
  const connector = spec.make();
  const engine = spec.mongo
    ? createMongoAskSql({ connector, model, answerSchemaQuestions: true })
    : createAskSql({ connectors: [connector], model, answerSchemaQuestions: true });

  try {
    // A data question must still produce a query that runs. This is the regression guard on the
    // advice router: over-matching would silently turn ordinary questions into prose.
    const data = await route(engine, 'how many orders are there for each status');
    if (data.kind === 'sql') {
      const rows = spec.mongo ? await engine.execute(data.sql, 'orders') : await engine.execute(data.sql);
      record(spec.name, 'data question -> query that runs', rows.rowCount >= 0, JSON.stringify(data));
    } else {
      record(spec.name, 'data question -> query that runs', false, JSON.stringify(data));
    }

    // The reported failure, both phrasings.
    for (const q of [
      'can you check if i wants improve db schema what are the possiblities',
      'can you please review the db schema and tell me to improve relations between tables what needs to update',
      'how can I improve the relationships between these tables',
    ]) {
      const r = await route(engine, q);
      const text = r.answer ?? r.sql ?? r.message ?? '';
      record(
        spec.name,
        `advice -> prose, no catalog query: "${q.slice(0, 34)}"`,
        r.kind === 'prose' && !isCatalogListing(text) && !/IMPOSSIBLE/i.test(text),
        JSON.stringify(r),
      );
    }

    // A listing question must NOT be swept into the advice route.
    const listing = await route(engine, 'show me all the tables in this database');
    record(
      spec.name,
      'listing question still answered',
      listing.kind === 'sql' || (listing.kind === 'prose' && listing.answer.length > 20),
      JSON.stringify(listing),
    );

    // A write request is a proposal with an explanation, never an execution.
    const write = await route(engine, 'write a statement that deletes cancelled orders');
    const answer = write.answer ?? '';
    record(
      spec.name,
      'write -> proposal, explained, read-only note',
      write.kind === 'prose' &&
        /delete|remove/i.test(answer) &&
        /read-only/i.test(answer) &&
        answer.split(/\s+/).length > 25,
      JSON.stringify(write),
    );

    // Performance and index advice over a 16-table schema: the shape the router was widened for.
    if (spec.big) {
      for (const q of [
        'which indexes should I add to speed up the join between orders and order_items',
        'how can I improve the performance of queries joining orders, customers and regions',
        'is my data model missing any constraints',
      ]) {
        const r = await route(engine, q);
        const text = r.answer ?? r.sql ?? r.message ?? '';
        record(
          spec.name,
          `index/performance advice -> prose: "${q.slice(0, 34)}"`,
          r.kind === 'prose' && !isCatalogListing(text) && text.length > 60,
          JSON.stringify(r),
        );
      }
      // Query optimisation as people actually phrase it, including a pasted statement.
      const OPTIMISATION = [
        "why is this query slow: SELECT * FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id WHERE o.status = 'paid'",
        'optimize this query: SELECT c.email, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.email',
        'should I add a composite index on orders (customer_id, placed_at)',
        'would denormalizing order_items into orders help performance',
        'what is the best index strategy for filtering orders by status and date',
        'how do I make this join faster between products, inventory and warehouses',
      ];
      for (const q of OPTIMISATION) {
        const r = await route(engine, q);
        const text = r.answer ?? r.sql ?? r.message ?? '';
        // Prose may legitimately name a catalog table while explaining; only a generated query
        // (kind === 'sql') is the failure this guards against.
        record(
          spec.name,
          `optimisation advice -> prose: "${q.slice(0, 34)}"`,
          r.kind === 'prose' && text.length > 60,
          JSON.stringify(r),
        );
      }

      // A genuine multi-join data question over the same schema must still produce SQL.
      const joined = await route(engine, 'total order value per region, joining orders to customers to regions');
      record(
        spec.name,
        'multi-join data question -> query',
        joined.kind === 'sql' && /join/i.test(joined.sql),
        JSON.stringify(joined),
      );
    }

    // Off-topic stays declined.
    const offTopic = await route(engine, 'what is the weather in Paris tomorrow');
    const offText = offTopic.answer ?? offTopic.sql ?? offTopic.message ?? '';
    record(
      spec.name,
      'off-topic declined',
      offTopic.kind !== 'sql' && !/SELECT/i.test(offText),
      JSON.stringify(offTopic),
    );

    // Nothing above may have moved a row.
    if (!spec.mongo) {
      const guard = await engine
        .execute('DELETE FROM orders')
        .then(() => 'ALLOWED')
        .catch((e) => e?.code ?? 'blocked');
      record(spec.name, 'a write through execute() is refused', guard !== 'ALLOWED', String(guard));
    }
  } finally {
    await connector.close?.();
  }
}

const wanted = process.argv.slice(2);
const model = await resolveModel({
  provider: PROVIDER,
  model: MODEL,
  ...(process.env.ASKSQL_API_KEY ? { apiKey: process.env.ASKSQL_API_KEY } : {}),
  ...(PROVIDER === 'ollama' ? { baseURL: process.env.ASKSQL_BASE_URL ?? 'http://localhost:11434/v1' } : {}),
  ...(process.env.ASKSQL_BASE_URL && PROVIDER !== 'ollama' ? { baseURL: process.env.ASKSQL_BASE_URL } : {}),
});
for (const spec of await engines()) {
  if (wanted.length && !wanted.includes(spec.name)) continue;
  try {
    await runEngine(spec, model);
  } catch (err) {
    record(spec.name, 'engine reachable', false, err?.message ?? String(err));
  }
}

const failed = out.filter((r) => !r.pass);
console.log(`\n${out.length - failed.length}/${out.length} passed on ${PROVIDER}/${MODEL}`);
if (failed.length) console.log('failed:', failed.map((f) => `${f.engine}/${f.name}`).join(', '));
process.exit(failed.length ? 1 : 0);
