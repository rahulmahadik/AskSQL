/**
 * Pure prompt builders (SQL + Mongo). These construct the strings sent to the
 * model; the guard, not the prompt, is the security boundary, so here we only
 * assert that inputs (glossary, few-shots, context, dialect notes, overrides)
 * reach the text and that structure/limits hold.
 */

import { describe, expect, it } from 'vitest';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import { buildExplainSystem, buildExplainUser, buildRepairUser, buildSqlSystem, buildSqlUser } from '../src/prompt.js';
import {
  buildMongoExplainSystem,
  buildMongoExplainUser,
  buildMongoRepairUser,
  buildPipelineSystem,
  buildPipelineUser,
} from '../src/mongo/prompts.js';

describe('buildSqlSystem', () => {
  it('includes the dialect label, row cap and dialect notes', () => {
    const sys = buildSqlSystem(POSTGRES_DIALECT, 500);
    expect(sys).toContain('PostgreSQL');
    expect(sys).toContain('at most 500');
    // Postgres has promptNotes, rendered as a bulleted notes section.
    expect(sys).toMatch(/PostgreSQL notes:\n- /);
  });

  it('appends host instructions and yields fully to a system override', () => {
    const withInstructions = buildSqlSystem(POSTGRES_DIALECT, 100, { instructions: 'Prefer CTEs.' });
    expect(withInstructions).toContain('Additional instructions:\nPrefer CTEs.');

    const overridden = buildSqlSystem(POSTGRES_DIALECT, 100, {
      system: ({ dialectLabel, maxRows }) => `CUSTOM ${dialectLabel} ${maxRows}`,
    });
    expect(overridden).toBe('CUSTOM PostgreSQL 100');
  });
});

describe('buildSqlUser', () => {
  it('wraps the schema and appends the question', () => {
    const user = buildSqlUser({
      question: 'how many users',
      schemaText: 'TABLE users',
      dialect: POSTGRES_DIALECT,
      maxRows: 100,
    });
    expect(user).toContain('<schema>\nTABLE users\n</schema>');
    expect(user.trimEnd().endsWith('Question: how many users')).toBe(true);
  });

  it('renders glossary, few-shots and the last few context turns', () => {
    const user = buildSqlUser({
      question: 'now by region',
      schemaText: 'TABLE sales',
      dialect: POSTGRES_DIALECT,
      maxRows: 100,
      glossary: [{ term: 'MRR', definition: 'monthly recurring revenue' }],
      fewShots: [{ question: 'total sales', sql: 'SELECT sum(amt) FROM sales' }],
      context: [
        { question: 'q1', sql: 'SELECT 1' },
        { question: 'q2', sql: 'SELECT 2' },
      ],
    });
    expect(user).toContain('Business glossary');
    expect(user).toContain('- MRR: monthly recurring revenue');
    expect(user).toContain('Examples of good answers');
    expect(user).toContain('SELECT sum(amt) FROM sales');
    expect(user).toContain('Conversation so far');
    expect(user).toContain('The next question may refine the previous query.');
  });

  it('keeps only the last four context turns', () => {
    const context = Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, sql: `SELECT ${i}` }));
    const user = buildSqlUser({ question: 'x', schemaText: 's', dialect: POSTGRES_DIALECT, maxRows: 10, context });
    expect(user).not.toContain('SELECT 1'); // q0/q1 dropped
    expect(user).toContain('SELECT 5');
  });
});

describe('buildRepairUser', () => {
  it('embeds the failed SQL and the failure reason', () => {
    const r = buildRepairUser({
      question: 'q',
      failedSql: 'SELECT bogus FROM t',
      failure: 'unknown column bogus',
      schemaText: 'TABLE t',
      dialect: POSTGRES_DIALECT,
    });
    expect(r).toContain('SELECT bogus FROM t');
    expect(r).toContain('Failure: unknown column bogus');
    expect(r).toContain('PostgreSQL');
  });

  it('notes when no SQL was produced', () => {
    const r = buildRepairUser({
      question: 'q',
      failedSql: '',
      failure: 'no sql',
      schemaText: 's',
      dialect: POSTGRES_DIALECT,
    });
    expect(r).toContain('(no SQL was produced)');
  });
});

describe('buildExplain (SQL)', () => {
  it('builds the system and user prompts, with an optional schema block', () => {
    expect(buildExplainSystem(POSTGRES_DIALECT)).toContain('Explain PostgreSQL queries');
    const withSchema = buildExplainUser('SELECT 1', 'TABLE t');
    expect(withSchema).toContain('<schema>\nTABLE t\n</schema>');
    expect(withSchema).toContain('SELECT 1');
    const noSchema = buildExplainUser('SELECT 2');
    expect(noSchema).not.toContain('<schema>');
    expect(noSchema).toContain('SELECT 2');
  });
});

describe('mongo prompt builders', () => {
  it('appends custom instructions to the pipeline system prompt', () => {
    expect(buildPipelineSystem(200)).not.toContain('Additional instructions');
    expect(buildPipelineSystem(200, '  keep it simple  ')).toContain('Additional instructions:\nkeep it simple');
    // Whitespace-only instructions are ignored.
    expect(buildPipelineSystem(200, '   ')).not.toContain('Additional instructions');
  });

  it('renders glossary, few-shots and context in the pipeline user prompt', () => {
    const user = buildPipelineUser({
      question: 'top sellers',
      schemaText: 'COLLECTION orders',
      glossary: [{ term: 'AOV', definition: 'average order value' }],
      fewShots: [{ question: 'count orders', pipelineJson: '[{"$count":"n"}]' }],
      context: [{ question: 'earlier', pipelineJson: '[{"$match":{}}]' }],
    });
    expect(user).toContain('COLLECTION orders');
    expect(user).toContain('- AOV: average order value');
    expect(user).toContain('[{"$count":"n"}]');
    expect(user).toContain('Conversation so far');
    expect(user).toContain('The next question may refine the previous pipeline.');
    expect(user.trimEnd().endsWith('Question: top sellers')).toBe(true);
  });

  it('builds the mongo repair prompt with and without a prior pipeline', () => {
    const withPrior = buildMongoRepairUser({
      question: 'q',
      failedPipeline: '[{"$bad":1}]',
      failure: 'boom',
      schemaText: 's',
    });
    expect(withPrior).toContain('[{"$bad":1}]');
    expect(withPrior).toContain('Failure: boom');
    const noPrior = buildMongoRepairUser({ question: 'q', failure: 'boom', schemaText: 's' });
    expect(noPrior).toContain('(no pipeline was produced)');
  });

  it('builds the mongo explain prompts, with an optional schema block', () => {
    expect(buildMongoExplainSystem()).toContain('aggregation pipelines');
    const withSchema = buildMongoExplainUser('[{"$match":{}}]', 'COLLECTION t');
    expect(withSchema).toContain('<schema>\nCOLLECTION t\n</schema>');
    expect(withSchema).toContain('[{"$match":{}}]');
    const noSchema = buildMongoExplainUser('[{"$limit":5}]');
    expect(noSchema).not.toContain('<schema>');
  });
});
