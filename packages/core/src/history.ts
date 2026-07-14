/**
 * In-memory HistoryStore. Bounded FIFO; newest first. Persistence
 * is pluggable via the HistoryStore interface.
 */

import type { HistoryEntry, HistoryPage, HistoryStore } from './types.js';

export class MemoryHistoryStore implements HistoryStore {
  private readonly entries: HistoryEntry[] = [];

  constructor(private readonly cap = 500) {}

  async add(entry: HistoryEntry): Promise<void> {
    this.entries.unshift(entry);
    if (this.entries.length > this.cap) this.entries.length = this.cap;
  }

  async list(
    connectionId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<HistoryPage> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
    const offset = Math.max(0, opts?.offset ?? 0);
    const filtered = this.entries.filter((e) => e.connectionId === connectionId);
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }
}

let counter = 0;

/** Monotonic, dependency-free id (no crypto needed for history rows). */
export function historyId(): string {
  counter += 1;
  return `h_${Date.now().toString(36)}_${counter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Few-shot store - in-memory, term-overlap retrieval.
// ---------------------------------------------------------------------------

import type { FewShotExample, FewShotStore } from './types.js';

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'by', 'and', 'or', 'how', 'many', 'what', 'is', 'are', 'per', 'each', 'all', 'show', 'list', 'get']);
function terms(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9_]+/u).filter((w) => w.length > 2 && !STOP.has(w)),
);
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export class MemoryFewShotStore implements FewShotStore {
  private readonly byConn = new Map<string, FewShotExample[]>();
  constructor(private readonly capPerConn = 200) {}

  async add(connectionId: string, example: FewShotExample): Promise<void> {
    const list = this.byConn.get(connectionId) ?? [];
    // De-dup identical questions (keep the latest SQL).
    const existing = list.findIndex((e) => e.question.trim().toLowerCase() === example.question.trim().toLowerCase());
    if (existing >= 0) list.splice(existing, 1);
    list.unshift(example);
    if (list.length > this.capPerConn) list.length = this.capPerConn;
    this.byConn.set(connectionId, list);
}

async retrieve(connectionId: string, question: string, limit: number): Promise<readonly FewShotExample[]> {
  const list = this.byConn.get(connectionId) ?? [];
  const q = terms(question);
  return list
  .map((ex) => ({ ex, score: overlap(q, terms(ex.question)) }))
  .filter((s) => s.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, limit)
  .map((s) => s.ex);
}
}
