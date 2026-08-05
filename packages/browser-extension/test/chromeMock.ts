/**
 * Minimal in-memory chrome.* mock for unit-testing storage.ts/permissions.ts
 * and friends outside a real browser. Installed fresh per test via
 * installChromeMock() so state never leaks between tests.
 */
import { vi } from 'vitest';

export interface ChromeMock {
  local: Map<string, unknown>;
  session: Map<string, unknown>;
  grantedOrigins: Set<string>;
  opfsFiles: Set<string>;
  /** background.ts registers these at module load; tests fire them directly instead of driving a real browser event. */
  fireOnInstalled: () => void;
  fireContextMenuClick: (info: { menuItemId: string; selectionText?: string }, tab?: { id?: number }) => void;
  fireStorageChanged: (changes: Record<string, { newValue?: unknown }>, area: string) => void;
  contextMenuCreateCalls: { id?: string; title?: string; contexts?: string[] }[];
  sidePanelOpenCalls: { tabId?: number }[];
  setPanelBehaviorCalls: { openPanelOnActionClick?: boolean }[];
  /** Makes the next call to the given API reject/report failure, to exercise background.ts's error logging. */
  failNext: {
    setPanelBehavior: boolean;
    contextMenusCreate: boolean;
    sidePanelOpen: boolean;
    storageSessionSet: boolean;
    updateDynamicRules: boolean;
  };
  dynamicRules: Map<number, unknown>;
}

/** Minimal in-memory stand-in for the OPFS root directory handle persistence.ts uses. */
function makeOpfsRoot(files: Set<string>) {
  return {
    async getFileHandle(name: string) {
      if (!files.has(name)) {
        const err = new Error(`File not found: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
      return {};
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
    async *keys() {
      yield* files;
    },
  };
}

function makeArea(store: Map<string, unknown>, shouldFailSet?: () => boolean) {
  return {
    get: vi.fn(async (keys: string | string[] | null) => {
      if (keys === null) return Object.fromEntries(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (store.has(k)) out[k] = store.get(k);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      if (shouldFailSet?.()) throw new Error('storage.set failed');
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    }),
    clear: vi.fn(async () => {
      store.clear();
    }),
  };
}

export function installChromeMock(): ChromeMock {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const grantedOrigins = new Set<string>();
  const opfsFiles = new Set<string>();
  const onInstalledListeners: (() => void)[] = [];
  const contextMenuClickListeners: ((
    info: { menuItemId: string; selectionText?: string },
    tab?: { id?: number },
  ) => void)[] = [];
  const storageChangedListeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
  const contextMenuCreateCalls: { id?: string; title?: string; contexts?: string[] }[] = [];
  const sidePanelOpenCalls: { tabId?: number }[] = [];
  const setPanelBehaviorCalls: { openPanelOnActionClick?: boolean }[] = [];
  const failNext = {
    setPanelBehavior: false,
    contextMenusCreate: false,
    sidePanelOpen: false,
    storageSessionSet: false,
    updateDynamicRules: false,
  };
  const dynamicRules = new Map<number, unknown>();

  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory: async () => makeOpfsRoot(opfsFiles) } },
    configurable: true,
    writable: true,
  });

  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: makeArea(local),
      session: makeArea(session, () => failNext.storageSessionSet),
      onChanged: {
        addListener: vi.fn((cb: (typeof storageChangedListeners)[number]) => storageChangedListeners.push(cb)),
        removeListener: vi.fn((cb: (typeof storageChangedListeners)[number]) => {
          const at = storageChangedListeners.indexOf(cb);
          if (at >= 0) storageChangedListeners.splice(at, 1);
        }),
      },
    },
    permissions: {
      contains: vi.fn(async ({ origins }: { origins?: string[] }) =>
        (origins ?? []).every((o) => grantedOrigins.has(o)),
      ),
      request: vi.fn(async ({ origins }: { origins?: string[] }) => {
        for (const o of origins ?? []) grantedOrigins.add(o);
        return true;
      }),
      remove: vi.fn(async ({ origins }: { origins?: string[] }) => {
        for (const o of origins ?? []) grantedOrigins.delete(o);
        return true;
      }),
      getAll: vi.fn(async () => ({ origins: [...grantedOrigins], permissions: [] })),
    },
    contextMenus: {
      create: vi.fn((props: { id?: string; title?: string; contexts?: string[] }, callback?: () => void) => {
        contextMenuCreateCalls.push(props);
        (globalThis as { chrome: { runtime: { lastError?: { message: string } } } }).chrome.runtime.lastError =
          failNext.contextMenusCreate ? { message: 'duplicate id' } : undefined;
        callback?.();
      }),
      onClicked: {
        addListener: vi.fn((cb: (typeof contextMenuClickListeners)[number]) => contextMenuClickListeners.push(cb)),
      },
    },
    declarativeNetRequest: {
      updateDynamicRules: vi.fn(
        async ({ removeRuleIds, addRules }: { removeRuleIds?: number[]; addRules?: { id: number }[] }) => {
          if (failNext.updateDynamicRules) throw new Error('blocked by enterprise policy');
          for (const id of removeRuleIds ?? []) dynamicRules.delete(id);
          for (const rule of addRules ?? []) dynamicRules.set(rule.id, rule);
        },
      ),
    },
    sidePanel: {
      open: vi.fn(async (opts: { tabId?: number }) => {
        sidePanelOpenCalls.push(opts);
        if (failNext.sidePanelOpen) throw new Error('sidePanel.open failed');
      }),
      setPanelBehavior: vi.fn(async (opts: { openPanelOnActionClick?: boolean }) => {
        setPanelBehaviorCalls.push(opts);
        if (failNext.setPanelBehavior) throw new Error('setPanelBehavior failed');
      }),
    },
    runtime: {
      id: 'test-id',
      getManifest: vi.fn(() => ({ version: '0.1.0' })),
      getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
      openOptionsPage: vi.fn(),
      onInstalled: { addListener: vi.fn((cb: () => void) => onInstalledListeners.push(cb)) },
      lastError: undefined as { message: string } | undefined,
    },
  };

  return {
    local,
    session,
    grantedOrigins,
    opfsFiles,
    fireOnInstalled: () => onInstalledListeners.forEach((cb) => cb()),
    fireContextMenuClick: (info, tab) => contextMenuClickListeners.forEach((cb) => cb(info, tab)),
    fireStorageChanged: (changes, area) => storageChangedListeners.forEach((cb) => cb(changes, area)),
    contextMenuCreateCalls,
    sidePanelOpenCalls,
    setPanelBehaviorCalls,
    failNext,
    dynamicRules,
  };
}

export function uninstallChromeMock(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
