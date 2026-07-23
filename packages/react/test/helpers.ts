/** Shared fixtures + a scriptable fake Transport for the DOM/hook tests. */
import type { ResultSet, SchemaCatalog } from '@asksql/core';
import type { ChatEvent, ConnectionSummary, Transport } from '../src/client.js';

export const emptyCatalog: SchemaCatalog = {
  engine: 'postgres',
  schemas: [],
  tables: [],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
};

export function resultOf(overrides: Partial<ResultSet> = {}): ResultSet {
  return {
    columns: [
      { name: 'region', kind: 'text' },
      { name: 'total', kind: 'number' },
    ],
    rows: [
      ['EU', 100],
      ['NA', 250],
    ],
    rowCount: 2,
    truncated: false,
    durationMs: 3,
    warnings: [],
    ...overrides,
  };
}

/** An async generator that emits a fixed script of events. */
export function chatOf(...events: ChatEvent[]) {
  return async function* (): AsyncIterable<ChatEvent> {
    for (const ev of events) yield ev;
  };
}

/** A promise the test resolves by hand, to hold a stream open (busy state). */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export interface FakeTransportOptions {
  connections?: ConnectionSummary[];
  chat?: Transport['chat'];
  execute?: Transport['execute'];
  schema?: Transport['schema'];
  explainSchema?: Transport['explainSchema'];
}

/** Minimal Transport whose async surface returns canned values. */
export function makeTransport(opts: FakeTransportOptions = {}): Transport {
  return {
    listConnections: async () => opts.connections ?? [],
    schema: opts.schema ?? (async () => emptyCatalog),
    chat: opts.chat ?? chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
    execute: opts.execute ?? (async () => resultOf()),
    explain: async () => '',
    explainSchema:
      opts.explainSchema ??
      (async () => ({ answer: '', tables: [], grounded: true, unknownReferences: [], isSchemaChange: false })),
  };
}
