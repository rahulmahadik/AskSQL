// @vitest-environment jsdom
/**
 * The row cap has to travel with the request. An in-page engine reads it from its own policy, but
 * a sidecar cannot see a client-side setting at all - so without this it silently did nothing for
 * server-backed connections while the options page presented it as global.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAskSql } from '../src/useAskSql.js';
import type { ChatEvent, Transport } from '../src/client.js';
import type { ExecuteOptions, ResultSet, SchemaCatalog } from '@asksql/core';

const EMPTY: ResultSet = { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 1, warnings: [] };

function recordingTransport(): { transport: Transport; seen: (ExecuteOptions & { connectionId?: string })[] } {
  const seen: (ExecuteOptions & { connectionId?: string })[] = [];
  const transport: Transport = {
    async listConnections() {
      return [];
    },
    async schema() {
      return {} as SchemaCatalog;
    },
    async *chat(): AsyncIterable<ChatEvent> {
      yield { type: 'sql', sql: 'SELECT 1', explanation: '' } as ChatEvent;
      yield { type: 'done' } as ChatEvent;
    },
    async execute(_sql, opts) {
      seen.push(opts ?? {});
      return EMPTY;
    },
    async explain() {
      return '';
    },
    async explainSchema() {
      return { answer: '', tables: [], grounded: true, unknownReferences: [], isSchemaChange: false };
    },
  };
  return { transport, seen };
}

describe('the row cap reaches the transport', () => {
  it('sends maxRows with the query when one is configured', async () => {
    const { transport, seen } = recordingTransport();
    const { result } = renderHook(() => useAskSql({ transport, connectionId: 'db', maxRows: 42 }));

    await act(async () => {
      await result.current.ask('how many orders');
    });

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]!.maxRows).toBe(42);
  });

  it('picks up a raised cap on re-render, without waiting for the transport to change identity', async () => {
    const { transport, seen } = recordingTransport();
    const { result, rerender } = renderHook(({ maxRows }) => useAskSql({ transport, connectionId: 'db', maxRows }), {
      initialProps: { maxRows: 100 },
    });

    rerender({ maxRows: 5000 });
    await act(async () => {
      await result.current.ask('how many orders');
    });

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]!.maxRows).toBe(5000);
  });

  it('sends nothing when none is configured, so the server keeps its own cap', async () => {
    const { transport, seen } = recordingTransport();
    const { result } = renderHook(() => useAskSql({ transport, connectionId: 'db' }));

    await act(async () => {
      await result.current.ask('how many orders');
    });

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]!.maxRows).toBeUndefined();
  });
});
