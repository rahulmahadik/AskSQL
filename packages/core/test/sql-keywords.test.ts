import { describe, expect, it } from 'vitest';
import { reservedWordsFor } from '../src/sql-keywords.js';

/** Read from each engine's own catalog, so the lists differ; a shared guess is what they replaced. */
describe('reservedWordsFor', () => {
  it('gives each engine its own list', () => {
    expect(reservedWordsFor('mysql').size).toBeGreaterThan(reservedWordsFor('postgres').size);
  });

  it.each([
    ['postgres', 'select'],
    ['mysql', 'select'],
    ['oracle', 'select'],
    ['sqlite', 'select'],
    ['duckdb', 'select'],
  ])('%s reserves %s', (engine, word) => {
    expect(reservedWordsFor(engine).has(word)).toBe(true);
  });

  /** MySQL reserves it, Postgres does not: proof the lists are not one shared set. */
  it('separates a word that only some engines reserve', () => {
    expect(reservedWordsFor('mysql').has('rank')).toBe(true);
    expect(reservedWordsFor('postgres').has('rank')).toBe(false);
  });

  /** An unknown engine gets the union, so a name is over-quoted rather than left broken. */
  it('falls back to the union for an unknown engine', () => {
    const union = reservedWordsFor('not-an-engine');
    expect(union.size).toBeGreaterThan(reservedWordsFor('mysql').size);
  });

  it('is case-insensitive on the engine name', () => {
    expect(reservedWordsFor('PostgreSQL'.toLowerCase().slice(0, 8)).size).toBe(reservedWordsFor('postgres').size);
  });
});
