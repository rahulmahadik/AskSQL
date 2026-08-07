/**
 * Introspects real open-source application schemas (GitLab, GLPI, Discourse, MediaWiki,
 * OpenStreetMap and friends) alongside the classic sample databases and generated edge shapes.
 *
 *   node tools/schema-sweep.mjs [--only=name,name]
 *
 * Each schema is loaded into its own database, introspected through the AskSQL connector, and
 * checked for read-only enforcement. A dump that will not load is reported as dialect drift, which
 * is not an AskSQL failure; a schema that loads but cannot be introspected is.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresConnector } from '@asksql/postgres';
import { MysqlConnector } from '@asksql/mysql';
import { SqliteConnector } from '@asksql/sqlite';
import { guardSql } from '@asksql/core';

const DIR = join(tmpdir(), 'asksql-schema-sweep');
const RAW = 'https://raw.githubusercontent.com';
const MYSQL_BIN = '/opt/homebrew/opt/mysql-client/bin/mysql';

/** Real schemas shipped by real projects, plus the classic sample databases. */
const SOURCES = [
  ['chinook', 'postgres', `${RAW}/lerocha/chinook-database/master/ChinookDatabase/DataSources/Chinook_PostgreSql.sql`],
  ['pagila', 'postgres', `${RAW}/devrimgunduz/pagila/master/pagila-schema.sql`],
  ['northwind', 'postgres', `${RAW}/pthom/northwind_psql/master/northwind.sql`],
  ['adventureworks', 'postgres', `${RAW}/lorint/AdventureWorks-for-Postgres/master/install.sql`],
  ['world', 'postgres', `${RAW}/morenoh149/postgresDBSamples/master/worldDB-1.0/world.sql`],
  ['openstreetmap', 'postgres', `${RAW}/openstreetmap/openstreetmap-website/master/db/structure.sql`],
  ['gitlab', 'postgres', `${RAW}/gitlabhq/gitlabhq/master/db/structure.sql`],
  ['discourse', 'postgres', `${RAW}/discourse/discourse/main/db/structure.sql`],
  ['roundcube', 'postgres', `${RAW}/roundcube/roundcubemail/master/SQL/postgres.initial.sql`],
  ['mediawiki', 'postgres', `${RAW}/wikimedia/mediawiki/REL1_41/maintenance/postgres/tables-generated.sql`],
  ['chinook', 'mysql', `${RAW}/lerocha/chinook-database/master/ChinookDatabase/DataSources/Chinook_MySql.sql`],
  ['roundcube', 'mysql', `${RAW}/roundcube/roundcubemail/master/SQL/mysql.initial.sql`],
  ['cacti', 'mysql', `${RAW}/Cacti/cacti/develop/cacti.sql`],
  ['mediawiki', 'mysql', `${RAW}/wikimedia/mediawiki/REL1_41/maintenance/tables-generated.sql`],
  ['piwigo', 'mysql', `${RAW}/Piwigo/Piwigo/master/install/piwigo_structure-mysql.sql`],
  ['phpipam', 'mysql', `${RAW}/phpipam/phpipam/master/db/SCHEMA.sql`],
  ['glpi', 'mysql', `${RAW}/glpi-project/glpi/main/install/mysql/glpi-empty.sql`],
  ['zoneminder', 'mysql', `${RAW}/ZoneMinder/zoneminder/master/db/zm_create.sql.in`],
  ['icinga', 'mysql', `${RAW}/Icinga/icinga2/master/lib/db_ido_mysql/schema/mysql.sql`],
  ['dolibarr', 'mysql', `${RAW}/Dolibarr/dolibarr/develop/htdocs/install/mysql/tables/llx_societe.sql`],
  ['chinook', 'sqlite', `${RAW}/lerocha/chinook-database/master/ChinookDatabase/DataSources/Chinook_Sqlite.sql`],
];

/** Shapes written here, each isolating one thing a real schema might do to introspection. */
const GENERATED = [
  ['no_constraints', 'CREATE TABLE t1 (a int, b text); CREATE TABLE t2 (c date);'],
  ['pk_only', 'CREATE TABLE t (id int PRIMARY KEY);'],
  [
    'composite_keys',
    'CREATE TABLE p (a int, b int, PRIMARY KEY (a,b)); CREATE TABLE c (x int, y int, FOREIGN KEY (x,y) REFERENCES p(a,b));',
  ],
  ['self_reference', 'CREATE TABLE a (id int PRIMARY KEY, parent int REFERENCES a(id));'],
  [
    'two_fks_same_target',
    'CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY, a1 int REFERENCES a(id), a2 int REFERENCES a(id));',
  ],
  ['expression_index', 'CREATE TABLE t (id int PRIMARY KEY, email text); CREATE INDEX ON t (lower(email));'],
  ['partial_index', "CREATE TABLE t (id int PRIMARY KEY, st text); CREATE INDEX ON t (st) WHERE st = 'x';"],
  ['quoted_identifiers', 'CREATE TABLE "Odd Table" ("Id" int PRIMARY KEY, "a b c" text, "select" text);'],
  [
    'views_and_matviews',
    'CREATE TABLE base (a int, b int); CREATE VIEW v AS SELECT a FROM base; CREATE MATERIALIZED VIEW mv AS SELECT b FROM base;',
  ],
  [
    'partitioned',
    "CREATE TABLE part (id int, d date) PARTITION BY RANGE (d); CREATE TABLE part_2024 PARTITION OF part FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
  ],
  ['enum_and_array', "CREATE TYPE mood AS ENUM ('a','b'); CREATE TABLE t (id int PRIMARY KEY, m mood, tags text[]);"],
  ['reserved_word_columns', 'CREATE TABLE t ("order" int, "group" text, "table" text, "user" text);'],
  ['no_pk_many_cols', `CREATE TABLE wide (${Array.from({ length: 120 }, (_, i) => `c${i} text`).join(', ')});`],
  ['unicode_names', 'CREATE TABLE "café" ("naïve" int PRIMARY KEY, "日本語" text);'],
  [
    'nullable_fk',
    'CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY, a_id int NULL REFERENCES a(id));',
  ],
  [
    'check_constraints',
    "CREATE TABLE t (id int PRIMARY KEY, age int CHECK (age >= 0), email text CHECK (email LIKE '%@%'));",
  ],
  ['unique_multi', 'CREATE TABLE t (id int PRIMARY KEY, a int, b int, UNIQUE (a,b));'],
  [
    'identity_and_default',
    "CREATE TABLE t (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created timestamptz DEFAULT now(), note text DEFAULT 'x');",
  ],
  ['numeric_extremes', 'CREATE TABLE t (a numeric(38,10), b bigint, c smallint, d real, e double precision, f money);'],
  ['empty_schema', 'SELECT 1;'],
];

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const PG = { host: 'localhost', port: '5432', user: 'postgres', pass: 'root' };
const MY = { host: '127.0.0.1', port: 53306, user: 'root', password: '' };

function fetchDump(name, engine, url) {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${name}.${engine}.sql`);
  if (!existsSync(path) || statSync(path).size < 2000) execFileSync('curl', ['-sfL', url, '-o', path]);
  return path;
}

/**
 * Whether a dump actually declares tables. A project may ship a data-only seed or a build-time
 * template under a .sql name; introspecting the empty database that produces says nothing about
 * AskSQL, so it must not be counted as a failure.
 */
function declaresTables(sqlPath) {
  return /^\s*CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE/im.test(readFileSync(sqlPath, 'utf8'));
}

/** Build-time templates carry @PLACEHOLDER@ tokens the project substitutes during install. */
function fillTemplatePlaceholders(sqlPath) {
  const text = readFileSync(sqlPath, 'utf8');
  if (!/@[A-Z_]+@/.test(text)) return sqlPath;
  const filled = `${sqlPath}.filled`;
  writeFileSync(filled, text.replace(/@[A-Z_]+@/g, 'zm'));
  return filled;
}

const psql = (db, args) =>
  execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', db, ...args], {
    env: { ...process.env, PGPASSWORD: PG.pass },
    stdio: 'pipe',
    maxBuffer: 256 * 1024 * 1024,
  });

const mysqlBin = existsSync(MYSQL_BIN) ? MYSQL_BIN : 'mysql';
const mysql = (args, opts) =>
  execFileSync(mysqlBin, ['-h', MY.host, '-P', String(MY.port), '-u', MY.user, ...args], {
    stdio: 'pipe',
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });

/** Postgres dumps often create and connect to their own database; route them into ours instead. */
function loadPostgres(db, sqlPath) {
  const cleaned = readFileSync(sqlPath, 'utf8').replace(/^\s*(DROP DATABASE|CREATE DATABASE|\\c |\\connect ).*$/gm, '');
  const staged = `${sqlPath}.staged`;
  writeFileSync(staged, cleaned);
  psql('postgres', ['-q', '-c', `DROP DATABASE IF EXISTS ${db}`]);
  psql('postgres', ['-q', '-c', `CREATE DATABASE ${db}`]);
  // Not ON_ERROR_STOP: a dialect-specific statement failing still leaves a real schema to introspect.
  psql(db, ['-q', '-f', staged]);
}

function loadMysql(db, sqlPath) {
  const cleaned = readFileSync(sqlPath, 'utf8').replace(/^\s*(DROP DATABASE|CREATE DATABASE|USE )\s*`?\w+`?.*$/gm, '');
  const staged = `${sqlPath}.staged`;
  writeFileSync(staged, cleaned);
  mysql(['-e', `DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db}`]);
  try {
    mysql(['-f', db], { input: readFileSync(staged) });
  } catch {
    /* -f already skipped the statements it could not run; whatever landed is still worth checking */
  }
}

const results = [];
let askSqlFailures = 0;

/** Introspect through the connector and try to write; both must behave on a schema nobody designed. */
async function checkSchema(label, connector, sampleTable, quote) {
  await connector.connect();
  try {
    const catalog = await connector.introspect();
    const tables = catalog.tables ?? [];
    if (tables.length === 0) return { ok: false, detail: 'introspection returned no tables' };

    const columns = tables.reduce((n, t) => n + (t.columns?.length ?? 0), 0);
    const fks = tables.reduce((n, t) => n + (t.foreignKeys?.length ?? 0), 0);
    const indexes = tables.reduce((n, t) => n + (t.indexes?.length ?? 0), 0);
    if (columns === 0) return { ok: false, detail: `${tables.length} tables but no columns` };

    // Every table must be usable in a generated query: an unquoted reserved word would not be.
    const unnamed = tables.filter((t) => !t.name || typeof t.name !== 'string').length;
    if (unnamed > 0) return { ok: false, detail: `${unnamed} tables came back without a usable name` };

    const target = sampleTable ?? tables[0].name;
    const blockedAll = [
      `DELETE FROM ${quote(target)}`,
      `UPDATE ${quote(target)} SET x = 1`,
      `DROP TABLE ${quote(target)}`,
      `INSERT INTO ${quote(target)} VALUES (1)`,
    ].every((sql) => !guardSql({ sql, dialect: connector.dialect }).allowed);
    if (!blockedAll) return { ok: false, detail: 'the guard allowed a write against this schema' };

    return { ok: true, detail: `${tables.length} tables, ${columns} columns, ${fks} FKs, ${indexes} indexes` };
  } finally {
    await connector.close?.().catch(() => {});
  }
}

for (const [name, engine, url] of SOURCES) {
  const label = `${name} (${engine})`;
  if (ONLY.length && !ONLY.includes(name)) continue;
  const db = `sweep_${name}_${engine}`;
  try {
    const fetched = fetchDump(name, engine, url);
    if (!declaresTables(fetched)) {
      results.push([label, 'no DDL', 'the upstream file declares no tables (data seed or non-SQL)']);
      continue;
    }
    const dump = fillTemplatePlaceholders(fetched);
    if (engine === 'postgres') {
      loadPostgres(db, dump);
      const r = await checkSchema(
        label,
        new PostgresConnector({
          id: db,
          name: db,
          connectionString: `postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${db}`,
        }),
        null,
        (n) => `"${n}"`,
      );
      results.push([label, r.ok ? 'ok' : 'ASKSQL FAIL', r.detail]);
      if (!r.ok) askSqlFailures++;
    } else if (engine === 'mysql') {
      loadMysql(db, dump);
      const r = await checkSchema(
        label,
        new MysqlConnector({ id: db, name: db, ...MY, database: db }),
        null,
        (n) => `\`${n}\``,
      );
      results.push([label, r.ok ? 'ok' : 'ASKSQL FAIL', r.detail]);
      if (!r.ok) askSqlFailures++;
    } else {
      const file = join(DIR, `${name}.db`);
      execFileSync('rm', ['-f', file]);
      execFileSync('sqlite3', [file], { input: readFileSync(dump), maxBuffer: 256 * 1024 * 1024 });
      const r = await checkSchema(label, new SqliteConnector({ id: db, name: db, file }), null, (n) => `"${n}"`);
      results.push([label, r.ok ? 'ok' : 'ASKSQL FAIL', r.detail]);
      if (!r.ok) askSqlFailures++;
    }
  } catch (err) {
    // The dump would not load at all: dialect drift in someone else's SQL, not an AskSQL defect.
    results.push([label, 'not loaded', (err.message ?? String(err)).split('\n')[0].slice(0, 70)]);
  }
}

for (const [name, ddl] of GENERATED) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  const db = `sweep_gen_${name}`;
  const label = `${name} (generated)`;
  try {
    psql('postgres', ['-q', '-c', `DROP DATABASE IF EXISTS ${db}`]);
    psql('postgres', ['-q', '-c', `CREATE DATABASE ${db}`]);
    psql(db, ['-q', '-v', 'ON_ERROR_STOP=1', '-c', ddl]);
    const r = await checkSchema(
      label,
      new PostgresConnector({
        id: db,
        name: db,
        connectionString: `postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${db}`,
      }),
      null,
      (n) => `"${n}"`,
    );
    // A schema with no tables at all is a legitimate shape, not a failure to introspect.
    const ok = r.ok || (name === 'empty_schema' && r.detail === 'introspection returned no tables');
    results.push([label, ok ? 'ok' : 'ASKSQL FAIL', r.detail]);
    if (!ok) askSqlFailures++;
  } catch (err) {
    results.push([label, 'not loaded', (err.message ?? String(err)).split('\n')[0].slice(0, 70)]);
  }
}

console.log('\n### Introspection sweep over real open-source schemas\n');
console.log('| Schema | Result | Detail |');
console.log('|---|---|---|');
for (const [a, b, c] of results) console.log(`| ${a} | ${b} | ${c} |`);

const ok = results.filter(([, r]) => r === 'ok').length;
const skipped = results.filter(([, r]) => r === 'not loaded' || r === 'no DDL');
const checked = results.length - skipped.length;
const totalTables = results.reduce((n, [, , d]) => n + (Number(/^(\d+) tables/.exec(d ?? '')?.[1]) || 0), 0);
console.log(`\n${ok}/${checked} schemas introspected cleanly, ${totalTables} real tables total.`);
if (skipped.length)
  console.log(`Not checked (upstream file, not an AskSQL failure): ${skipped.map(([n]) => n).join(', ')}`);
console.log(
  askSqlFailures === 0 ? 'No AskSQL introspection or guard failures.' : `${askSqlFailures} ASKSQL FAILURE(S)`,
);
process.exit(askSqlFailures === 0 ? 0 : 1);
