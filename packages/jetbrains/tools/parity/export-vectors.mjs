#!/usr/bin/env node
// Regenerates golden guard/prompt vectors from the PUBLISHED @asksql/core
// (never from the monorepo's local packages/core - the plugin ships against
// what's on npm, so parity is measured against that, not local HEAD). Runs
// only in CI's `parity` job and in local dev via `./gradlew parityVectors`;
// never on an end user's machine.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  guardSql,
  POSTGRES_DIALECT,
  MYSQL_DIALECT,
  SQLITE_DIALECT,
  DUCKDB_DIALECT,
  buildSqlSystem,
  buildSqlUser,
  buildRepairUser,
} from '@asksql/core';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'vectors');
mkdirSync(outDir, { recursive: true });

const DIALECTS = {
  postgres: POSTGRES_DIALECT,
  mysql: MYSQL_DIALECT,
  sqlite: SQLITE_DIALECT,
  duckdb: DUCKDB_DIALECT,
};

function loadCorpus() {
  const raw = readFileSync(join(here, 'corpus.sql.jsonl'), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function exportGuardVectors() {
  const corpus = loadCorpus();
  const vectors = corpus.map(({ sql, engine }) => {
    const dialect = DIALECTS[engine];
    if (!dialect) throw new Error(`Unknown engine in corpus: ${engine}`);
    const verdict = guardSql({ sql, dialect });
    return {
      sql,
      engine,
      allowed: verdict.allowed,
      ruleId: verdict.ruleId ?? null,
      finalSql: verdict.allowed ? verdict.sql : null,
      autoLimited: verdict.allowed ? verdict.autoLimited : null,
      loweredLimit: verdict.allowed ? verdict.loweredLimit : null,
    };
  });
  writeFileSync(join(outDir, 'guard.json'), JSON.stringify(vectors, null, 2) + '\n');
  console.log(`Wrote ${vectors.length} guard vectors -> tools/parity/vectors/guard.json`);
}

function exportPromptVectors() {
  const dialect = POSTGRES_DIALECT;
  const maxRows = 1000;
  const schemaText = [
    'TABLE users [~1200 rows]',
    ' id integer PK NOT NULL',
    ' name text NOT NULL',
    ' email text',
    'TABLE orders [~5400 rows]',
    ' id integer PK NOT NULL',
    ' user_id integer FK->users.id NOT NULL',
    ' total_cents integer NOT NULL',
    'RELATIONSHIPS (join paths):',
    ' orders.user_id = users.id',
  ].join('\n');

  const vectors = {
    system: buildSqlSystem(dialect, maxRows),
    user: buildSqlUser({ question: 'top 5 customers by total spend', schemaText, dialect, maxRows }),
    repair: buildRepairUser({
      question: 'top 5 customers by total spend',
      failedSql: 'SELECT * FROM userz',
      failure: 'Table "userz" does not exist in the schema. Use only tables from the <schema> block.',
      schemaText,
      dialect,
    }),
  };
  writeFileSync(join(outDir, 'prompts.json'), JSON.stringify(vectors, null, 2) + '\n');
  console.log('Wrote prompt vectors -> tools/parity/vectors/prompts.json');
}

exportGuardVectors();
exportPromptVectors();
