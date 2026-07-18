/**
 * Saved / pinned queries. Client-side (per-user UI state), backed by
 * localStorage when available with an in-memory fallback so it works during
 * SSR and in tests. Pure + injectable storage -> unit-testable.
 */

import { useCallback, useEffect, useState } from 'react';

export interface SavedQuery {
  readonly id: string;
  readonly name: string;
  readonly question: string;
  readonly sql: string;
  readonly connectionId?: string;
  readonly savedAt: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryStore = (): KeyValueStore => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

function defaultStore(): KeyValueStore {
  try {
    if (typeof localStorage !== 'undefined') {
      // Probe (Safari private mode throws on setItem).
      localStorage.setItem('__asksql_probe', '1');
      localStorage.removeItem('__asksql_probe');
      return localStorage;
    }
  } catch {
    /* fall through to memory */
  }
  return memoryStore();
}

const KEY = 'asksql.saved-queries';
let seq = 0;

export class SavedQueryStore {
  constructor(private readonly kv: KeyValueStore = defaultStore()) {}

  list(): SavedQuery[] {
    try {
      const raw = this.kv.getItem(KEY);
      return raw ? (JSON.parse(raw) as SavedQuery[]) : [];
    } catch {
      return [];
    }
  }

  save(q: Omit<SavedQuery, 'id' | 'savedAt'> & { at?: string }): SavedQuery {
    const list = this.list();
    const entry: SavedQuery = {
      id: `sq_${(seq += 1).toString(36)}_${list.length}`,
      name: q.name || q.question.slice(0, 60),
      question: q.question,
      sql: q.sql,
      connectionId: q.connectionId,
      savedAt: q.at ?? new Date().toISOString(),
    };
    const next = [entry, ...list].slice(0, 200);
    this.kv.setItem(KEY, JSON.stringify(next));
    return entry;
  }

  remove(id: string): void {
    this.kv.setItem(KEY, JSON.stringify(this.list().filter((q) => q.id !== id)));
  }
}

/** React hook over a {@link SavedQueryStore}. */
export function useSavedQueries(store?: SavedQueryStore): {
  saved: SavedQuery[];
  save: (q: Omit<SavedQuery, 'id' | 'savedAt'>) => void;
  remove: (id: string) => void;
} {
  const [s] = useState(() => store ?? new SavedQueryStore());
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  useEffect(() => setSaved(s.list()), [s]);
  const save = useCallback(
    (q: Omit<SavedQuery, 'id' | 'savedAt'>) => {
      s.save(q);
      setSaved(s.list());
    },
    [s],
  );
  const remove = useCallback(
    (id: string) => {
      s.remove(id);
      setSaved(s.list());
    },
    [s],
  );
  return { saved, save, remove };
}
