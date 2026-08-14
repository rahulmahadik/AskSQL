/**
 * Runs the engine's identifier handling against real databases and hostile schemas.
 *
 * A mixed-case Postgres schema once failed every query and shipped that way for weeks, because
 * every database test we owned used tables we had written ourselves and so shared our blind spots.
 * This uses schemas built to break the rules instead: mixed case, reserved words, spaces, unicode,
 * names that are parser keywords.
 *
 * No model is involved. A model is not needed to catch this class of defect and would make the
 * result non-deterministic; the harness writes the bare, unquoted SQL a model produces, puts it
 * through the same normalise-then-guard path the engine uses, and executes it.
 *
 * Each fixture also asserts the naive form genuinely fails on a folding engine, so the suite cannot
 * pass by doing nothing.
 *
 * Usage:
 *   node tools/schema-regression.mjs              # every engine it can reach
 *   node tools/schema-regression.mjs --engine=postgres
 *
 * Connection details come from the environment, with local defaults:
 *   ASKSQL_PG_URL, ASKSQL_MYSQL_HOST/PORT/USER/PASSWORD
 * An engine that cannot be reached is reported as skipped, never as a pass.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// needsQuoting and quoteCatalogIdentifiers are internal to the engine; this reads the built files
// rather than widening the package's public surface for a test tool.
const { guardSql } = await import('../packages/core/dist/guard.js');
const { needsQuoting } = await import('../packages/core/dist/catalog.js');
const { quoteCatalogIdentifiers } = await import('../packages/core/dist/identifier-case.js');
const { reservedWordsFor } = await import('../packages/core/dist/sql-keywords.js');

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:pg@127.0.0.1:5433/schema_regression';
const MYSQL = {
  host: process.env['ASKSQL_MYSQL_HOST'] ?? '127.0.0.1',
  port: Number(process.env['ASKSQL_MYSQL_PORT'] ?? 3307),
  user: process.env['ASKSQL_MYSQL_USER'] ?? 'root',
  password: process.env['ASKSQL_MYSQL_PASSWORD'] ?? '',
};

/**
 * Each fixture is the same schema written the way a real database would hold it, per dialect.
 * `probe` is the question a model would answer with bare names.
 */
const FIXTURES = [
  {
    name: 'mixed case',
    postgres: [
      `CREATE TABLE "Customers" ("CustomerId" INT, "FirstName" TEXT, "Country" TEXT)`,
      `INSERT INTO "Customers" VALUES (1, 'Ada', 'UK')`,
    ],
    mysql: [
      'CREATE TABLE `Customers` (`CustomerId` INT, `FirstName` VARCHAR(50), `Country` VARCHAR(50))',
      "INSERT INTO `Customers` VALUES (1, 'Ada', 'UK')",
    ],
    sqlite: [
      `CREATE TABLE "Customers" ("CustomerId" INTEGER, "FirstName" TEXT, "Country" TEXT)`,
      `INSERT INTO "Customers" VALUES (1, 'Ada', 'UK')`,
    ],
  },
  {
    name: 'reserved words as names',
    postgres: [`CREATE TABLE "order" ("select" INT, "group" TEXT)`, `INSERT INTO "order" VALUES (1, 'a')`],
    mysql: ['CREATE TABLE `order` (`select` INT, `group` VARCHAR(20))', "INSERT INTO `order` VALUES (1, 'a')"],
    sqlite: [`CREATE TABLE "order" ("select" INTEGER, "group" TEXT)`, `INSERT INTO "order" VALUES (1, 'a')`],
  },
  {
    name: 'a name the parser treats as a keyword',
    postgres: [`CREATE TABLE "Nulls" ("Id" INT, "Val" TEXT)`, `INSERT INTO "Nulls" VALUES (1, NULL)`],
    mysql: ['CREATE TABLE `Nulls` (`Id` INT, `Val` VARCHAR(20))', 'INSERT INTO `Nulls` VALUES (1, NULL)'],
    sqlite: [`CREATE TABLE "Nulls" ("Id" INTEGER, "Val" TEXT)`, `INSERT INTO "Nulls" VALUES (1, NULL)`],
  },
  {
    name: 'spaces and symbols',
    postgres: [
      `CREATE TABLE "Order Items" ("item id" INT, "unit-price" NUMERIC)`,
      `INSERT INTO "Order Items" VALUES (1, 9.99)`,
    ],
    mysql: [
      'CREATE TABLE `Order Items` (`item id` INT, `unit-price` DECIMAL(10,2))',
      'INSERT INTO `Order Items` VALUES (1, 9.99)',
    ],
    sqlite: [
      `CREATE TABLE "Order Items" ("item id" INTEGER, "unit-price" REAL)`,
      `INSERT INTO "Order Items" VALUES (1, 9.99)`,
    ],
  },
  {
    name: 'unicode',
    postgres: [`CREATE TABLE "Ünïcødé" ("naïve_col" TEXT)`, `INSERT INTO "Ünïcødé" VALUES ('x')`],
    mysql: [
      'CREATE TABLE `Ünïcødé` (`naïve_col` VARCHAR(20)) DEFAULT CHARSET=utf8mb4',
      "INSERT INTO `Ünïcødé` VALUES ('x')",
    ],
    sqlite: [`CREATE TABLE "Ünïcødé" ("naïve_col" TEXT)`, `INSERT INTO "Ünïcødé" VALUES ('x')`],
  },
  {
    name: 'a column named like its table',
    postgres: [`CREATE TABLE "Country" ("Country" TEXT, "Customers" INT)`, `INSERT INTO "Country" VALUES ('UK', 3)`],
    mysql: [
      'CREATE TABLE `Country` (`Country` VARCHAR(20), `Customers` INT)',
      "INSERT INTO `Country` VALUES ('UK', 3)",
    ],
    sqlite: [`CREATE TABLE "Country" ("Country" TEXT, "Customers" INTEGER)`, `INSERT INTO "Country" VALUES ('UK', 3)`],
  },
];

/**
 * A name can only be written without quotes when it is a plain word that is not a keyword. A name
 * with a space has no bare form at all, so asking for one would test an input no model produces.
 */
function canBeBare(name, engine) {
  return /^[A-Za-z_]\w*$/.test(name) && !reservedWordsFor(engine).has(name.toLowerCase());
}

const quote = (name, quoteChar) => `${quoteChar}${name}${quoteChar === '[' ? ']' : quoteChar}`;

/**
 * The two shapes a model actually emits. `bare` is the one that broke: correct spelling, no quotes,
 * which a folding engine then resolves to something else. `quoted` must survive untouched.
 */
function probes(table, engine, quoteChar) {
  const name = (n) => (canBeBare(n, engine) ? n : quote(n, quoteChar));
  const out = [
    {
      shape: 'quoted',
      sql: `SELECT ${table.columns.map((c) => quote(c.name, quoteChar)).join(', ')} FROM ${quote(table.name, quoteChar)}`,
    },
  ];
  const bareable = canBeBare(table.name, engine) && table.columns.every((c) => canBeBare(c.name, engine));
  if (bareable) {
    out.unshift({
      shape: 'bare',
      sql: `SELECT ${table.columns.map((c) => name(c.name)).join(', ')} FROM ${name(table.name)}`,
    });
  }
  return out;
}

/** The engine's own path: quote what the database would not read back, then guard, then run. */
function normalise(sql, catalog, engine, quoteChar) {
  const all = catalog.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]);
  const spellings = new Map();
  for (const n of all) {
    const set = spellings.get(n.toLowerCase()) ?? new Set();
    set.add(n);
    spellings.set(n.toLowerCase(), set);
  }
  const quotable = all.filter((n) => needsQuoting(n, engine) && spellings.get(n.toLowerCase())?.size === 1);
  const tables = catalog.tables.map((t) => t.name).filter((n) => quotable.includes(n));
  return quoteCatalogIdentifiers(sql, quotable, quoteChar, tables) ?? sql;
}

const results = [];
const record = (engine, fixture, status, detail = '') => {
  results.push({ engine, fixture, status, detail });
  const mark = status === 'pass' ? 'ok  ' : status === 'skip' ? 'skip' : 'FAIL';
  console.log(`  ${mark}  ${fixture}${detail ? ` - ${detail}` : ''}`);
};

/**
 * Runs every fixture against one engine.
 * `run` executes a statement; `introspect` returns the catalog; both come from the real connector.
 */
async function checkEngine({ engine, quoteChar, connect, folds }) {
  console.log(`\n${engine}`);
  let session;
  try {
    session = await connect();
  } catch (err) {
    record(engine, 'connection', 'skip', String(err).split('\n')[0].slice(0, 80));
    return;
  }
  try {
    for (const fixture of FIXTURES) {
      const ddl = fixture[engine === 'duckdb' ? 'sqlite' : engine];
      if (!ddl) continue;
      try {
        await session.reset();
        for (const statement of ddl) await session.run(statement);
      } catch (err) {
        record(engine, fixture.name, 'skip', `fixture rejected: ${String(err).split('\n')[0].slice(0, 60)}`);
        continue;
      }

      let catalog;
      try {
        catalog = await session.introspect();
      } catch (err) {
        record(engine, fixture.name, 'fail', `introspection failed: ${String(err).split('\n')[0].slice(0, 70)}`);
        continue;
      }
      const table = catalog.tables.at(-1);
      if (!table) {
        record(engine, fixture.name, 'fail', 'introspection returned no table');
        continue;
      }

      for (const probe of probes(table, engine, quoteChar)) {
        const label = `${fixture.name} [${probe.shape}]`;

        // A bare name on a folding engine must genuinely fail, or the fixture proves nothing.
        if (folds && probe.shape === 'bare') {
          try {
            await session.run(probe.sql);
            record(engine, label, 'fail', 'the bare form was accepted, so this fixture tests nothing');
            continue;
          } catch {
            // expected: this is the defect the normalisation exists to fix
          }
        }

        const fixed = normalise(probe.sql, catalog, engine, quoteChar);
        const verdict = guardSql({ sql: fixed, dialect: session.dialect });
        if (!verdict.allowed) {
          record(engine, label, 'fail', `guard rejected it: ${(verdict.reason ?? verdict.ruleId ?? '').slice(0, 60)}`);
          continue;
        }
        try {
          await session.run(verdict.sql);
          record(engine, label, 'pass');
        } catch (err) {
          record(engine, label, 'fail', String(err).split('\n')[0].slice(0, 90));
        }
      }
    }
  } finally {
    // Closing must not mask whatever the fixture was reporting.
    await session.close().catch(() => {});
  }
}

async function postgresSession() {
  // pg is the connector's own dependency, not the repo root's.
  const { default: pg } = await import('../packages/postgres/node_modules/pg/lib/index.js');
  const { POSTGRES_DIALECT } = await import('../packages/core/dist/dialects.js');
  const { PostgresConnector } = await import('@asksql/postgres');
  const client = new pg.Client(PG_URL);
  await client.connect();
  return {
    dialect: POSTGRES_DIALECT,
    run: (sql) => client.query(sql),
    reset: () => client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'),
    // A fresh connector each time, so the catalog is never a cached view of an older fixture.
    introspect: async () => {
      const connector = new PostgresConnector({ id: 'pg', name: 'pg', connectionString: PG_URL });
      try {
        await connector.connect();
        return await connector.introspect();
      } finally {
        await connector.close().catch(() => {});
      }
    },
    close: () => client.end(),
  };
}

async function mysqlSession() {
  // mysql2 is the connector's own dependency, not the repo root's.
  const mysql = (await import('../packages/mysql/node_modules/mysql2/promise.js')).default;
  const { MYSQL_DIALECT } = await import('../packages/core/dist/dialects.js');
  const { MysqlConnector } = await import('@asksql/mysql');
  const admin = await mysql.createConnection(MYSQL);
  await admin.query('CREATE DATABASE IF NOT EXISTS schema_regression');
  await admin.changeUser({ database: 'schema_regression' });
  return {
    dialect: MYSQL_DIALECT,
    run: (sql) => admin.query(sql),
    reset: async () => {
      const [rows] = await admin.query('SHOW TABLES');
      for (const row of rows) await admin.query(`DROP TABLE IF EXISTS \`${Object.values(row)[0]}\``);
    },
    // A fresh connector each time, so the catalog is never a cached view of an older fixture.
    introspect: async () => {
      const connector = new MysqlConnector({ id: 'my', name: 'my', ...MYSQL, database: 'schema_regression' });
      try {
        await connector.connect();
        return await connector.introspect();
      } finally {
        await connector.close().catch(() => {});
      }
    },
    close: () => admin.end(),
  };
}

async function sqliteSession() {
  const { SQLITE_DIALECT } = await import('../packages/core/dist/dialects.js');
  const { SqliteConnector } = await import('@asksql/sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'asksql-schema-')), 'x.db');
  let db = new DatabaseSync(file);
  return {
    dialect: SQLITE_DIALECT,
    run: async (sql) => db.exec(sql),
    reset: async () => {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        db.exec(`DROP TABLE IF EXISTS "${row.name}"`);
      }
    },
    introspect: async () => {
      // The connector opens the file read-only, so the writable handle is closed for the duration
      // and always reopened, even when introspection fails.
      db.close();
      const connector = new SqliteConnector({ id: 'sq', name: 'sq', file });
      try {
        await connector.connect();
        return await connector.introspect();
      } finally {
        await connector.close().catch(() => {});
        db = new DatabaseSync(file);
      }
    },
    close: async () => db.close(),
  };
}

const only = process.argv.find((a) => a.startsWith('--engine='))?.split('=')[1];
/**
 * Engines that must actually run. Without this, CI would go green on SQLite alone whenever the
 * database services failed to start, which is the shape of a suite that quietly stops testing.
 */
const required = (process.argv.find((a) => a.startsWith('--require='))?.split('=')[1] ?? '').split(',').filter(Boolean);
const ENGINES = [
  { engine: 'postgres', quoteChar: '"', folds: true, connect: postgresSession },
  { engine: 'mysql', quoteChar: '`', folds: false, connect: mysqlSession },
  { engine: 'sqlite', quoteChar: '"', folds: false, connect: sqliteSession },
];

for (const target of ENGINES) {
  if (only && target.engine !== only) continue;
  await checkEngine(target);
}

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip');
const passed = results.filter((r) => r.status === 'pass');
console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length > 0) {
  console.log('Skipped engines were unreachable; they are not a pass.');
}
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED ${f.engine} / ${f.fixture}: ${f.detail}`);
  process.exit(1);
}

const ranEngines = new Set(passed.map((r) => r.engine));
const missing = required.filter((e) => !ranEngines.has(e));
if (missing.length > 0) {
  console.log(`Required engines never ran: ${missing.join(', ')}. A skip is not a pass.`);
  process.exit(1);
}

if (passed.length === 0) {
  console.log('Nothing ran. Start a database, or pass --engine= for one you have.');
  process.exit(1);
}
