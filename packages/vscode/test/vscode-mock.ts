/**
 * A runtime stand-in for the `vscode` module, which only exists inside the
 * extension host. The root vitest config aliases `vscode` to this file for tests;
 * tsc still checks src against the real @types/vscode, so types stay honest.
 *
 * State (config, secrets, registered commands) is module-level and reset by
 * resetVscodeMock(), which every test suite calls in beforeEach.
 */

import { vi } from 'vitest';

// -- enums (real numeric values, matching vscode) --------------------------

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export const version = '1.95.0';

// -- simple value classes --------------------------------------------------

export class ThemeIcon {
  constructor(public id: string) {}
}

export class TreeItem {
  id?: string;
  description?: string | boolean;
  iconPath?: unknown;
  contextValue?: string;
  tooltip?: unknown;
  command?: unknown;
  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}

export class MarkdownString {
  value = '';
  isTrusted = false;
  appendText(s: string): this {
    // Mirror VS Code: appendText escapes markdown. A minimal escape is enough
    // for tests to assert nothing was injected.
    this.value += s;
    return this;
  }
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class CancellationTokenSource {
  private cancelled = false;
  private cbs: (() => void)[] = [];
  token = {
    get isCancellationRequested(): boolean {
      return false;
    },
    onCancellationRequested: (cb: () => void): { dispose: () => void } => {
      this.cbs.push(cb);
      return { dispose: () => {} };
    },
  };
  cancel(): void {
    this.cancelled = true;
    for (const cb of this.cbs) cb();
  }
  dispose(): void {
    this.cbs = [];
  }
}

export class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
}

// -- language model surface ------------------------------------------------

export class LanguageModelError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'LanguageModelError';
  }
  static NoPermissions(): LanguageModelError {
    return new LanguageModelError('NoPermissions');
  }
  static Blocked(): LanguageModelError {
    return new LanguageModelError('Blocked');
  }
  static NotFound(): LanguageModelError {
    return new LanguageModelError('NotFound');
  }
}

export const LanguageModelChatMessage = {
  User: (content: string): { role: string; content: string } => ({ role: 'user', content }),
};

// -- Uri -------------------------------------------------------------------

export class Uri {
  private constructor(
    public scheme: string,
    public path: string,
    public fsPath: string,
  ) {}
  static file(p: string): Uri {
    return new Uri('file', p, p);
  }
  static parse(s: string): Uri {
    const scheme = /^([a-z][\w+.-]*):/i.exec(s)?.[1] ?? 'file';
    return new Uri(scheme, s, s);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, joined, joined);
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
  with(): Uri {
    return this;
  }
}

// -- configuration store ---------------------------------------------------

interface Section {
  values: Record<string, unknown>;
  global: Record<string, unknown>;
  workspace: Record<string, unknown>;
}

const sections: Record<string, Section> = {};

function section(name: string): Section {
  return (sections[name] ??= { values: {}, global: {}, workspace: {} });
}

/** Records every config .update() call, for asserting write behaviour. */
export const configUpdates: { key: string; value: unknown; target: number | undefined }[] = [];

export const workspace = {
  getConfiguration: vi.fn((name = 'asksql') => {
    const sect = section(name);
    return {
      get: <T>(key: string, def?: T): T | undefined => {
        const v = sect.values[key];
        return (v === undefined ? def : v) as T | undefined;
      },
      inspect: <T>(key: string) => ({
        key: `${name}.${key}`,
        defaultValue: undefined as T | undefined,
        globalValue: sect.global[key] as T | undefined,
        workspaceValue: sect.workspace[key] as T | undefined,
        workspaceFolderValue: undefined as T | undefined,
      }),
      update: vi.fn(async (key: string, value: unknown, target?: number): Promise<void> => {
        configUpdates.push({ key, value, target });
        const bucket = target === ConfigurationTarget.Workspace ? sect.workspace : sect.global;
        if (value === undefined) {
          delete bucket[key];
          delete sect.values[key];
        } else {
          bucket[key] = value;
          sect.values[key] = value;
        }
      }),
    };
  }),
  workspaceFolders: undefined as { uri: Uri; name?: string }[] | undefined,
  openTextDocument: vi.fn(async (opts?: unknown) => ({ opts })),
  onDidChangeConfiguration: vi.fn((handler: (e: unknown) => void) => {
    workspaceConfigHandlers.push(handler);
    return new Disposable();
  }),
};

/** Captured onDidChangeConfiguration handlers, so a test can drive a config change. */
export const workspaceConfigHandlers: ((e: unknown) => void)[] = [];

// -- window ----------------------------------------------------------------

export const window = {
  showInputBox: vi.fn(async (_opts?: unknown): Promise<string | undefined> => undefined),
  showQuickPick: vi.fn(async (_items?: unknown, _opts?: unknown): Promise<unknown> => undefined),
  showInformationMessage: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showWarningMessage: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showErrorMessage: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showOpenDialog: vi.fn(async (_opts?: unknown): Promise<Uri[] | undefined> => undefined),
  showTextDocument: vi.fn(async (_doc?: unknown, _opts?: unknown): Promise<unknown> => ({})),
  createOutputChannel: vi.fn((_name: string, _opts?: unknown) => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    append: vi.fn(),
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  })),
  withProgress: vi.fn(
    async <T>(_opts: unknown, task: (progress: unknown, token: unknown) => Thenable<T>): Promise<T> => {
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: (_cb: () => void) => new Disposable(),
      };
      return task({ report: vi.fn() }, token);
    },
  ),
  registerTreeDataProvider: vi.fn(() => new Disposable()),
  registerWebviewViewProvider: vi.fn(() => new Disposable()),
  activeTextEditor: undefined as unknown,
};

// -- commands --------------------------------------------------------------

/** command id -> handler, populated by registerCommand. */
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
    registeredCommands.set(id, handler);
    return new Disposable();
  }),
  executeCommand: vi.fn(async (_id: string, ..._args: unknown[]): Promise<unknown> => undefined),
};

// -- env -------------------------------------------------------------------

export const env = {
  clipboard: {
    writeText: vi.fn(async (_text: string): Promise<void> => undefined),
    readText: vi.fn(async (): Promise<string> => ''),
  },
};

// -- language models -------------------------------------------------------

export const lm = {
  selectChatModels: vi.fn(async (_selector?: unknown): Promise<unknown[]> => []),
};

// -- secret storage helper -------------------------------------------------

/** A standalone SecretStorage-shaped fake, so each test can hold its own store. */
export function createSecretStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const emitter = new EventEmitter<{ key: string }>();
  return {
    get: vi.fn(async (key: string): Promise<string | undefined> => map.get(key)),
    store: vi.fn(async (key: string, value: string): Promise<void> => {
      map.set(key, value);
      emitter.fire({ key });
    }),
    delete: vi.fn(async (key: string): Promise<void> => {
      map.delete(key);
      emitter.fire({ key });
    }),
    onDidChange: emitter.event,
    _map: map,
  };
}

// -- test helpers ----------------------------------------------------------

/** Set effective config values (what getConfiguration().get() returns). */
export function setConfig(values: Record<string, unknown>, name = 'asksql'): void {
  Object.assign(section(name).values, values);
}

/** Set inspect() buckets and the effective value (workspace shadows global). */
export function setInspect(key: string, buckets: { global?: unknown; workspace?: unknown }, name = 'asksql'): void {
  const sect = section(name);
  if ('global' in buckets) sect.global[key] = buckets.global;
  if ('workspace' in buckets) sect.workspace[key] = buckets.workspace;
  const effective = 'workspace' in buckets ? buckets.workspace : buckets.global;
  if (effective !== undefined) sect.values[key] = effective;
}

export function setWorkspaceFolders(folders: { uri: Uri; name?: string }[] | undefined): void {
  workspace.workspaceFolders = folders;
}

/** Clear all state and reset every vi.fn to its default behaviour. */
export function resetVscodeMock(): void {
  for (const k of Object.keys(sections)) delete sections[k];
  configUpdates.length = 0;
  workspaceConfigHandlers.length = 0;
  registeredCommands.clear();
  workspace.workspaceFolders = undefined;
  window.activeTextEditor = undefined;
  vi.clearAllMocks();
  // clearAllMocks drains call history but NOT queued mockResolvedValueOnce
  // values; reset the scripted fns fully so no answer leaks into the next test.
  for (const fn of [
    window.showInputBox,
    window.showQuickPick,
    window.showInformationMessage,
    window.showWarningMessage,
    window.showErrorMessage,
    window.showOpenDialog,
    window.showTextDocument,
    window.withProgress,
    commands.executeCommand,
    lm.selectChatModels,
    env.clipboard.writeText,
    workspace.openTextDocument,
  ]) {
    fn.mockReset();
  }
  // Restore default resolved values that the reset wiped.
  window.showInputBox.mockResolvedValue(undefined);
  window.showQuickPick.mockResolvedValue(undefined);
  window.showInformationMessage.mockResolvedValue(undefined);
  window.showWarningMessage.mockResolvedValue(undefined);
  window.showErrorMessage.mockResolvedValue(undefined);
  window.showOpenDialog.mockResolvedValue(undefined);
  window.showTextDocument.mockResolvedValue({});
  window.withProgress.mockImplementation(
    async <T>(_opts: unknown, task: (p: unknown, t: unknown) => Thenable<T>): Promise<T> =>
      task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }),
  );
  commands.executeCommand.mockResolvedValue(undefined);
  lm.selectChatModels.mockResolvedValue([]);
  env.clipboard.writeText.mockResolvedValue(undefined);
  workspace.openTextDocument.mockImplementation(async (opts?: unknown) => ({ opts }));
}
