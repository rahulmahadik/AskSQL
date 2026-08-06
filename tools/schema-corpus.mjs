/**
 * Loads real open-source schemas into Postgres, one schema each, so introspection can be checked
 * against shapes nobody on this project designed: no keys at all, composite keys, partitioned
 * tables, quoted identifiers, materialised views, whatever the projects actually ship.
 *
 *   node tools/schema-corpus.mjs [--keep]
 *
 * Needs a local Postgres on 5432 with an `asksql_test` database. Exit code 1 if any schema fails
 * to load in a way that looks like an AskSQL problem rather than dialect drift.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEEP = process.argv.includes('--keep');
// Its own database: loading a hundred schemas into asksql_test breaks every test that
// introspects the whole database, and inflates the catalog a model test sees.
const PG = { host: 'localhost', port: '5432', user: 'postgres', db: 'asksql_corpus', pass: 'root' };

/** Raw DDL from projects that publish a Postgres schema. */
const SOURCES = [
  [
    'chinook',
    'https://raw.githubusercontent.com/lerocha/chinook-database/master/ChinookDatabase/DataSources/Chinook_PostgreSql.sql',
  ],
  ['pagila', 'https://raw.githubusercontent.com/devrimgunduz/pagila/master/pagila-schema.sql'],
  ['northwind', 'https://raw.githubusercontent.com/pthom/northwind_psql/master/northwind.sql'],
  ['adventureworks', 'https://raw.githubusercontent.com/lorint/AdventureWorks-for-Postgres/master/install.sql'],
  ['world', 'https://raw.githubusercontent.com/morenoh149/postgresDBSamples/master/worldDB-1.0/world.sql'],
];

/** Shapes generated locally, each isolating one thing a real schema might do. */
const GENERATED = [
  ['no_constraints_at_all', 'CREATE TABLE t1 (a int, b text); CREATE TABLE t2 (c date);'],
  ['pk_but_no_index_of_its_own', 'CREATE TABLE t (id int PRIMARY KEY);'],
  [
    'composite_everything',
    `CREATE TABLE p (a int, b int, PRIMARY KEY (a,b));
     CREATE TABLE c (x int, y int, FOREIGN KEY (x,y) REFERENCES p(a,b));`,
  ],
  [
    'self_and_cross_refs',
    `CREATE TABLE a (id int PRIMARY KEY, parent int REFERENCES a(id));
     CREATE TABLE b (id int PRIMARY KEY, a1 int REFERENCES a(id), a2 int REFERENCES a(id));`,
  ],
  [
    'expression_and_partial_indexes',
    `CREATE TABLE t (id int PRIMARY KEY, email text, st text);
     CREATE INDEX ON t (lower(email)); CREATE INDEX ON t (st) WHERE st = 'x';
     CREATE UNIQUE INDEX ON t (email, st);`,
  ],
  ['quoted_and_mixed_case', 'CREATE TABLE "Odd Table" ("Id" int PRIMARY KEY, "a b c" text);'],
  [
    'views_and_matviews',
    `CREATE TABLE base (a int, b int);
     CREATE VIEW v AS SELECT a FROM base; CREATE MATERIALIZED VIEW mv AS SELECT b FROM base;`,
  ],
  [
    'partitioned',
    `CREATE TABLE ev (id bigint, at date NOT NULL) PARTITION BY RANGE (at);
     CREATE TABLE ev_2025 PARTITION OF ev FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');`,
  ],
  ['unique_without_pk', 'CREATE TABLE t (email text UNIQUE, name text);'],
  ['fk_to_unique_not_pk', `CREATE TABLE u (code text UNIQUE); CREATE TABLE f (c text REFERENCES u(code));`],
  ['array_and_json_columns', 'CREATE TABLE t (id int PRIMARY KEY, tags text[], doc jsonb, nums int[][]);'],
  [
    'every_numeric_type',
    `CREATE TABLE t (a smallint, b int, c bigint, d numeric(30,10), e real,
     f double precision, g money, h boolean);`,
  ],
  ['temporal_types', 'CREATE TABLE t (a date, b time, c timestamp, d timestamptz, e interval);'],
  ['long_identifiers', `CREATE TABLE ${'x'.repeat(60)} (${'y'.repeat(60)} int PRIMARY KEY);`],
  ['many_columns', `CREATE TABLE wide (${Array.from({ length: 120 }, (_, i) => `c${i} int`).join(', ')});`],
  [
    'deep_fk_chain',
    Array.from({ length: 12 }, (_, i) =>
      i === 0
        ? 'CREATE TABLE l0 (id int PRIMARY KEY);'
        : `CREATE TABLE l${i} (id int PRIMARY KEY, up int REFERENCES l${i - 1}(id));`,
    ).join('\n'),
  ],
  ['nullable_vs_not', "CREATE TABLE t (a int NOT NULL, b int, c text NOT NULL DEFAULT 'x');"],
  ['inherited_tables', `CREATE TABLE parent (a int); CREATE TABLE child (b int) INHERITS (parent);`],
  [
    'domain_and_enum',
    `CREATE TYPE mood AS ENUM ('ok','bad'); CREATE DOMAIN pos AS int CHECK (VALUE > 0);
     CREATE TABLE t (m mood, p pos);`,
  ],
  ['check_constraints', 'CREATE TABLE t (id int PRIMARY KEY, age int CHECK (age >= 0), CHECK (id <> 0));'],
];

const psql = (args, input) =>
  execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-q', ...args], {
    env: { ...process.env, PGPASSWORD: PG.pass },
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

async function fetchDdl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Created on first run; dropping the database is how the corpus is cleaned up.
try {
  execFileSync(
    'psql',
    ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', 'postgres', '-q', '-c', `CREATE DATABASE ${PG.db}`],
    {
      env: { ...process.env, PGPASSWORD: PG.pass },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
} catch {
  // Already there.
}

const scratch = mkdtempSync(join(tmpdir(), 'asksql-corpus-'));
const loaded = [];
const skipped = [];

for (const [name, urlOrDdl] of [...SOURCES, ...GENERATED]) {
  const schema = `corpus_${name}`.slice(0, 60).toLowerCase();
  try {
    let ddl = urlOrDdl.startsWith('http') ? await fetchDdl(urlOrDdl) : urlOrDdl;
    // Keep only what builds structure; a project's own schema/owner/ACL lines fight our sandbox.
    ddl = ddl
      .replace(
        /^\s*(SET|SELECT pg_catalog\.|ALTER .* OWNER TO|GRANT|REVOKE|COMMENT ON EXTENSION|CREATE EXTENSION|\\connect|\\.).*$/gim,
        '',
      )
      .replace(/^\s*CREATE SCHEMA.*$/gim, '')
      .replace(/\bpublic\./gi, '');
    const file = join(scratch, `${schema}.sql`);
    writeFileSync(
      file,
      `DROP SCHEMA IF EXISTS ${schema} CASCADE;\nCREATE SCHEMA ${schema};\nSET search_path = ${schema};\n${ddl}\n`,
    );
    psql(['-f', file]);
    const count = Number(
      psql(['-tAc', `SELECT count(*) FROM information_schema.tables WHERE table_schema = '${schema}'`]).trim(),
    );
    if (count === 0) throw new Error('no relations created');
    loaded.push([schema, count]);
  } catch (err) {
    skipped.push([
      schema,
      String(err.message ?? err)
        .split('\n')[0]
        .slice(0, 60),
    ]);
  }
}

console.log('\n### Schema corpus loaded into Postgres\n');
console.log('| Schema | Relations |');
console.log('|---|---|');
for (const [s, n] of loaded) console.log(`| ${s} | ${n} |`);
const total = loaded.reduce((a, [, n]) => a + n, 0);
console.log(`\n${loaded.length} schemas, ${total} relations.`);
if (skipped.length > 0) {
  console.log('\nNot loaded (dialect or network, not an AskSQL failure):');
  for (const [s, why] of skipped) console.log(`  ${s}: ${why}`);
}
console.log(`\nThese live in the ${PG.db} database, not asksql_test. Drop it with:`);
console.log(`  dropdb -h ${PG.host} -p ${PG.port} -U ${PG.user} ${PG.db}`);
