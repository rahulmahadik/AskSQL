/**
 * Creates the `perf` schema that IntrospectionCostTest measures against: 300 tables, each with a
 * primary key, a foreign key and a secondary index, in the local `asksql_test` database.
 *
 *   node tools/perf-schema.mjs
 *
 * Idempotent: the schema is dropped and rebuilt.
 */
import { execFileSync } from 'node:child_process';

const TABLES = 300;
const DB = 'asksql_test';

const ddl = [`DROP SCHEMA IF EXISTS perf CASCADE`, `CREATE SCHEMA perf`];
for (let i = 0; i < TABLES; i++) {
  // Each table points at the one before it, so every table but the first carries a foreign key.
  const fk = i === 0 ? '' : `, parent_id int REFERENCES perf.t${i - 1}(id)`;
  ddl.push(`CREATE TABLE perf.t${i} (id int PRIMARY KEY, label text, created_at timestamptz${fk})`);
  ddl.push(`CREATE INDEX t${i}_label_idx ON perf.t${i} (label)`);
}

execFileSync(
  'psql',
  ['-h', 'localhost', '-p', '5432', '-U', 'postgres', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-c', ddl.join(';\n')],
  {
    env: { ...process.env, PGPASSWORD: 'root' },
    stdio: 'inherit',
  },
);

const count = String(
  execFileSync(
    'psql',
    [
      '-h',
      'localhost',
      '-p',
      '5432',
      '-U',
      'postgres',
      '-d',
      DB,
      '-tAc',
      `SELECT count(*) FROM information_schema.tables WHERE table_schema='perf'`,
    ],
    { env: { ...process.env, PGPASSWORD: 'root' } },
  ),
).trim();
console.log(`perf schema rebuilt in ${DB}: ${count} tables`);
process.exit(Number(count) >= TABLES ? 0 : 1);
