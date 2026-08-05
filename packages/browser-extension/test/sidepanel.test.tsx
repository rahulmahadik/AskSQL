// @vitest-environment jsdom
/**
 * The side panel's connection wiring under jsdom: which database id reaches the
 * chat, and what a second Connect click does while the first is still opening.
 * <AskSqlChat/> and the DuckDB-WASM connector are faked; the orchestration is
 * what is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { installChromeMock, uninstallChromeMock } from './chromeMock.js';

const { state, deferConnector } = vi.hoisted(() => {
  const shared = {
    chatProps: [] as Record<string, unknown>[],
    schemaCalls: [] as { id?: string; refresh?: boolean }[],
    fileConnections: [] as { id: string; name: string; tables: string[] }[],
    openCalls: 0,
    release: undefined as (() => void) | undefined,
  };
  return {
    state: shared,
    deferConnector: () => new Promise<void>((resolve) => (shared.release = resolve)),
  };
});

vi.mock('@asksql/react', () => ({
  AskSqlChat: (props: Record<string, unknown>) => {
    state.chatProps.push(props);
    return null;
  },
  SchemaBrowser: () => null,
  LocalTransport: class {
    constructor(readonly engine: unknown) {}
  },
  HttpTransport: class {
    constructor(readonly opts: unknown) {}
    async schema(id?: string, refresh?: boolean): Promise<{ tables: unknown[] }> {
      state.schemaCalls.push({ id, refresh });
      return { tables: [] };
    }
  },
}));

vi.mock('../src/fileConnections.js', () => ({
  getFileConnections: async () => state.fileConnections,
  openFileConnector: async () => {
    state.openCalls++;
    await deferConnector();
    return {
      id: 'file_1',
      name: 'Files',
      introspect: async () => ({ tables: [{ name: 't', columns: [] }] }),
      close: async () => {},
    };
  },
}));

const sidecar = {
  id: 's1',
  name: 'Prod',
  baseUrl: 'http://localhost:3000',
  remoteConnectionId: 'dyn_2',
};

async function mount(): Promise<void> {
  document.body.innerHTML = '<div id="root"></div>';
  // The escape hatch the examples use, so no provider call is made.
  (window as { __asksqlModel?: unknown }).__asksqlModel = { id: 'test-model' };
  await act(async () => {
    await import('../src/sidepanel/main.js');
  });
}

const buttonNamed = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

describe('side panel connection wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    state.chatProps.length = 0;
    state.schemaCalls.length = 0;
    state.fileConnections.length = 0;
    state.openCalls = 0;
    state.release = undefined;
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('runs the chat against the database the schema pane reads, not the first the server lists', async () => {
    await chrome.storage.local.set({ 'asksql.connections': [sidecar] });
    await mount();

    await act(async () => buttonNamed('Connect').click());
    await waitFor(() => expect(state.chatProps.length).toBeGreaterThan(0));

    const props = state.chatProps.at(-1)!;
    expect(props['connectionId']).toBe('dyn_2');
    expect(props['showConnectionPicker']).toBe(false);
    await waitFor(() => expect(state.schemaCalls[0]?.id).toBe('dyn_2'));
  });

  it('leaves the picker to a server entry that names no database of its own', async () => {
    await chrome.storage.local.set({
      'asksql.connections': [{ id: 's2', name: 'Sidecar', baseUrl: 'http://localhost:3000' }],
    });
    await mount();

    await act(async () => buttonNamed('Connect').click());
    await waitFor(() => expect(state.chatProps.length).toBeGreaterThan(0));

    const props = state.chatProps.at(-1)!;
    expect(props['connectionId']).toBeUndefined();
    expect(props['showConnectionPicker']).toBe(true);
  });

  it('opens one database handle when Connect is clicked twice before the first finishes', async () => {
    state.fileConnections.push({ id: 'file_1', name: 'Q1 sales', tables: ['sales'] });
    await mount();

    const connect = buttonNamed('Connect');
    await act(async () => {
      connect.click();
      connect.click();
    });
    expect(state.openCalls).toBe(1);

    await act(async () => {
      state.release?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(state.chatProps.length).toBeGreaterThan(0));
    expect(state.openCalls).toBe(1);
  });
});
