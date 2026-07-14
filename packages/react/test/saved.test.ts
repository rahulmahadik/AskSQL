/** Saved-query store (pure, injected KV). */
import { describe, expect, it } from 'vitest';
import { SavedQueryStore, type KeyValueStore } from '../src/saved.js';

function memKV(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('SavedQueryStore', () => {
  it('saves and lists newest-first', () => {
    const s = new SavedQueryStore(memKV());
    s.save({ name: 'A', question: 'q a', sql: 'SELECT 1' });
    s.save({ name: 'B', question: 'q b', sql: 'SELECT 2' });
    const list = s.list();
    expect(list.map((q) => q.name)).toEqual(['B', 'A']);
    expect(list[0]!.id).toBeTruthy();
  });

  it('derives a name from the question when none given', () => {
    const s = new SavedQueryStore(memKV());
    const e = s.save({ name: '', question: 'how many customers are there today?', sql: 'SELECT 1' });
    expect(e.name.length).toBeGreaterThan(0);
  });

  it('removes by id', () => {
    const s = new SavedQueryStore(memKV());
    const e = s.save({ name: 'x', question: 'q', sql: 'SELECT 1' });
    s.save({ name: 'y', question: 'q2', sql: 'SELECT 2' });
    s.remove(e.id);
    expect(s.list().map((q) => q.name)).toEqual(['y']);
  });

  it('survives corrupt storage without throwing', () => {
    const kv = memKV();
    kv.setItem('asksql.saved-queries', '{not json');
    const s = new SavedQueryStore(kv);
    expect(s.list()).toEqual([]);
    s.save({ name: 'ok', question: 'q', sql: 'SELECT 1' });
    expect(s.list()).toHaveLength(1);
  });
});
