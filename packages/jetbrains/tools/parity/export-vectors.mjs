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
  buildSchemaAnswerSystem,
  buildSchemaAnswerUser,
  buildSchemaAnswerScopeRepairUser,
  isOffTopic,
  looksDatabaseRelated,
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
    // The schema-answer path drifted silently before it was vectored: it carries the
    // scope guard, so a reworded rule on one side changes what the other side refuses.
    schemaAnswerSystem: buildSchemaAnswerSystem(dialect),
    schemaAnswerSystemDdl: buildSchemaAnswerSystem(dialect, true),
    schemaAnswerSystemNoScope: buildSchemaAnswerSystem(dialect, false, false),
    schemaAnswerUser: buildSchemaAnswerUser('what is this database for?', schemaText, ['orders.user_id = users.id']),
    schemaAnswerScopeRepair: buildSchemaAnswerScopeRepairUser(
      'how would I do this in MongoDB?',
      schemaText,
      dialect.promptLabel,
      ['orders.user_id = users.id'],
    ),
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

/**
 * Behavioural vectors for the scope classifiers. Comparing regex SOURCE would pass while
 * the two engines still disagreed (different flags, different escaping); comparing verdicts
 * on real strings is what actually has to match.
 */
function exportClassifierVectors() {
  const questions = [
    'tell me a joke about penguins',
    'what is the weather in Mumbai today?',
    'who won the football world cup in 2022?',
    'write me a python function that reverses a string',
    'what is this database for?',
    'how do I write a SQL JOIN here?',
    'how would I do this in MongoDB aggregation instead?',
    'what is a database index and when should I add one?',
    'delete my Spotify listening history',
    'Write a DELETE removing orders older than 2020',
    'summarise the tables',
    // Dead-alternation probe: \b after [sz] could never match "normalise"/"normalize".
    'how should I normalise this schema?',
    'should I denormalize for reporting?',
    'hello',
  ];
  const answers = [
    'OUT_OF_SCOPE',
    'Sorry - OUT_OF_SCOPE.',
    '  OUT_OF_SCOPE  ',
    'The orders table records purchases.',
    'This is OUT_OF_SCOPExx not the sentinel',
    // Past the length bound: a real answer that merely discusses the sentinel must not be
    // mistaken for a refusal.
    'The OUT_OF_SCOPE marker is what the model emits for questions unrelated to data. This answer is far longer than a refusal ever is, and describes the schema at length.',
    'OUT_OF_SCOPE - not a database question.',
    // Models reformat the sentinel, and an unmatched near-miss is rendered to the user verbatim.
    'OUT OF SCOPE',
    'out-of-scope',
    '**OUT_OF_SCOPE**',
    'This is about scope creep in the project plan and how we manage it across teams.',
  ];
  const vectors = {
    looksDatabaseRelated: Object.fromEntries(questions.map((q) => [q, looksDatabaseRelated(q)])),
    isOffTopic: Object.fromEntries(answers.map((a) => [a, isOffTopic(a)])),
  };
  writeFileSync(join(outDir, 'classifiers.json'), JSON.stringify(vectors, null, 2) + '\n');
  console.log('Wrote classifier vectors -> tools/parity/vectors/classifiers.json');
}

exportGuardVectors();
exportPromptVectors();
exportClassifierVectors();
