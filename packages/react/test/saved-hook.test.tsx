// @vitest-environment jsdom
/** useSavedQueries hook + the localStorage-backed default store. */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { SavedQueryStore, useSavedQueries, type KeyValueStore } from '../src/saved.js';

afterEach(cleanup);

function memKV(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('useSavedQueries', () => {
  it('lists, saves, and removes through the injected store', () => {
    const store = new SavedQueryStore(memKV());
    const { result } = renderHook(() => useSavedQueries(store));
    expect(result.current.saved).toEqual([]);

    act(() => result.current.save({ name: 'A', question: 'q', sql: 'SELECT 1' }));
    expect(result.current.saved.map((q) => q.name)).toEqual(['A']);

    const id = result.current.saved[0]!.id;
    act(() => result.current.remove(id));
    expect(result.current.saved).toEqual([]);
  });
});

describe('default localStorage store', () => {
  it('reads and writes through a working localStorage', () => {
    const backing = new Map<string, string>();
    const ls = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
    try {
      const s = new SavedQueryStore(); // no injected store -> probes localStorage
      s.save({ name: 'P', question: 'q', sql: 'SELECT 1' });
      expect(backing.has('asksql.saved-queries')).toBe(true);
      expect(new SavedQueryStore().list().map((q) => q.name)).toEqual(['P']);
    } finally {
      // @ts-expect-error remove the stub
      delete globalThis.localStorage;
    }
  });
});
