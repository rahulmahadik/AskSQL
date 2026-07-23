/**
 * Branch coverage for the small public utilities of the core hub: error coercion,
 * catalog-query hints, metadata-question detection, fuzzy table matching, the
 * IMPOSSIBLE-reason extractor, and the in-memory few-shot store.
 */
import { describe, expect, it } from 'vitest';
import { AskSqlError } from '../src/errors.js';
import { catalogQueryHint, isMetadataQuestion, closestTableName } from '../src/schema-match.js';
import { extractImpossible } from '../src/extract.js';
import { MemoryFewShotStore, MemoryHistoryStore } from '../src/history.js';
import type { HistoryEntry, SchemaCatalog } from '../src/types.js';

describe('AskSqlError.from', () => {
  it('returns an existing AskSqlError unchanged', () => {
    const orig = new AskSqlError('DB_TIMEOUT', { detail: 'x' });
    expect(AskSqlError.from(orig, 'DB_QUERY_ERROR')).toBe(orig);
  });
  it('wraps a plain Error, keeping name + message in detail', () => {
    const e = AskSqlError.from(new TypeError('boom'), 'DB_QUERY_ERROR');
    expect(e.code).toBe('DB_QUERY_ERROR');
    expect(e.detail).toContain('TypeError: boom');
  });
  it('wraps a non-Error thrown value', () => {
    const e = AskSqlError.from('just a string', 'DB_UNREACHABLE');
    expect(e.code).toBe('DB_UNREACHABLE');
    expect(e.detail).toContain('just a string');
  });
});

describe('catalogQueryHint covers every engine branch', () => {
  it('sqlite uses sqlite_master', () => expect(catalogQueryHint('sqlite')).toContain('sqlite_master'));
  it('mysql uses DATABASE()', () => expect(catalogQueryHint('mysql')).toContain('DATABASE()'));
  it('oracle uses all_tables', () => expect(catalogQueryHint('oracle')).toContain('all_tables'));
  it('postgres/default excludes system schemas', () => expect(catalogQueryHint('postgres')).toContain('pg_catalog'));
  it('duckdb falls through to the default', () => expect(catalogQueryHint('duckdb')).toContain('information_schema'));
});

describe('isMetadataQuestion', () => {
  it('is true for a structure question', () => expect(isMetadataQuestion('what tables are here?')).toBe(true));
  it('is false for a data question', () => expect(isMetadataQuestion('total revenue last month')).toBe(false));
});

const CAT: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'appointments',
      kind: 'table',
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
    {
      name: 'customers',
      kind: 'table',
      columns: [],
      primaryKey: [],
      foreignKeys: [],
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

describe('closestTableName', () => {
  it('finds a near-miss table name', () => {
    expect(closestTableName('show me the appointmnts', CAT)).toBe('appointments');
  });
  it('returns null when nothing is close', () => {
    expect(closestTableName('quarterly revenue by widget', CAT)).toBeNull();
  });
});

describe('extractImpossible', () => {
  it('returns null when there is no sentinel', () => {
    expect(extractImpossible('SELECT 1')).toBeNull();
  });
  it('extracts a short reason (sentence-cased)', () => {
    expect(extractImpossible('IMPOSSIBLE: no revenue column')).toBe('No revenue column');
  });
  it('truncates a very long reason at a word boundary with an ellipsis', () => {
    const long = 'IMPOSSIBLE: ' + 'word '.repeat(120).trim();
    const r = extractImpossible(long)!;
    expect(r.endsWith('…')).toBe(true);
    expect(r.length).toBeLessThan(long.length);
  });
});

describe('MemoryFewShotStore', () => {
  it('dedups the same question (keeps latest SQL) and retrieves by term overlap', async () => {
    const store = new MemoryFewShotStore();
    await store.add('c1', { question: 'orders by region', sql: 'SELECT 1' });
    await store.add('c1', { question: 'orders by region', sql: 'SELECT 2' });
    await store.add('c1', { question: 'top customers', sql: 'SELECT 3' });
    const hits = await store.retrieve('c1', 'orders grouped by region', 5);
    expect(hits).toHaveLength(1); // only the overlapping example
    expect(hits[0]!.sql).toBe('SELECT 2'); // latest after dedup
  });
  it('returns nothing for an unknown connection or a no-overlap question', async () => {
    const store = new MemoryFewShotStore();
    await store.add('c1', { question: 'orders by region', sql: 'SELECT 1' });
    expect(await store.retrieve('other', 'anything', 5)).toEqual([]);
    expect(await store.retrieve('c1', 'zzz qqq', 5)).toEqual([]);
  });
  it('caps stored examples per connection', async () => {
    const store = new MemoryFewShotStore(2);
    for (let i = 0; i < 5; i++) await store.add('c1', { question: `q${i}`, sql: `S${i}` });
    const hits = await store.retrieve('c1', 'q4 q3 q0', 10);
    expect(hits.length).toBeLessThanOrEqual(2);
  });
  it('scopes examples per user - one user never retrieves another user\'s approved SQL', async () => {
    const store = new MemoryFewShotStore();
    await store.add('c1', { question: 'revenue by region', sql: "SELECT ... WHERE tenant = 'acme'" }, 'alice');
    // Bob shares the connection but must not see Alice's private example.
    expect(await store.retrieve('c1', 'revenue by region', 5, 'bob')).toEqual([]);
    const alice = await store.retrieve('c1', 'revenue by region', 5, 'alice');
    expect(alice).toHaveLength(1);
    expect(alice[0]!.sql).toContain('acme');
  });
  it('an undefined userId (local mode) is its own bucket, separate from any named user', async () => {
    const store = new MemoryFewShotStore();
    await store.add('c1', { question: 'orders by region', sql: 'LOCAL' });
    await store.add('c1', { question: 'orders by region', sql: 'SERVER' }, 'alice');
    expect((await store.retrieve('c1', 'orders by region', 5))[0]!.sql).toBe('LOCAL');
    expect((await store.retrieve('c1', 'orders by region', 5, 'alice'))[0]!.sql).toBe('SERVER');
  });
});

describe('MemoryHistoryStore', () => {
  const entry = (connectionId: string, userId: string | undefined, id: string): HistoryEntry => ({
    id,
    at: new Date(1_700_000_000_000 + Number(id)).toISOString(),
    connectionId,
    userId,
    sql: `SELECT ${id}`,
    status: 'ok',
  });

  it('scopes list to the requesting user', async () => {
    const store = new MemoryHistoryStore();
    await store.add(entry('c1', 'alice', '1'));
    await store.add(entry('c1', 'bob', '2'));
    const forBob = await store.list('c1', { userId: 'bob' });
    expect(forBob.items.map((e) => e.id)).toEqual(['2']);
    expect(forBob.total).toBe(1);
  });

  it('retention is per-(connection,user): a busy tenant cannot evict another tenant\'s rows', async () => {
    const store = new MemoryHistoryStore(2); // cap 2 PER scope, not globally
    for (let i = 0; i < 10; i++) await store.add(entry('c1', 'busy', String(100 + i)));
    await store.add(entry('c1', 'quiet', '5'));
    const quiet = await store.list('c1', { userId: 'quiet' });
    expect(quiet.items.map((e) => e.id)).toEqual(['5']); // survived the busy tenant's flood
  });

  it('local mode (no userId) aggregates the connection\'s rows newest-first', async () => {
    const store = new MemoryHistoryStore();
    await store.add(entry('c1', undefined, '1'));
    await store.add(entry('c1', undefined, '3'));
    await store.add(entry('c2', undefined, '2'));
    const page = await store.list('c1');
    expect(page.items.map((e) => e.id)).toEqual(['3', '1']); // newest first, only c1
  });
});
