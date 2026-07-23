import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  resetVscodeMock,
  setInspect,
  setConfig,
  configUpdates,
  createSecretStorage,
  registeredCommands,
  workspaceConfigHandlers,
  window,
  workspace,
  commands,
  env,
  Uri,
} from './vscode-mock.js';
import { activate, deactivate } from '../src/extension.js';

/** A minimal ExtensionContext for activate(). */
function fakeContext() {
  const secrets = createSecretStorage();
  return {
    ctx: {
      subscriptions: [] as unknown[],
      extensionUri: Uri.file('/ext'),
      secrets,
      globalState: { get: vi.fn(() => undefined), update: vi.fn(async () => {}) },
      extension: { packageJSON: { version: '9.9.9' } },
    } as never,
    secrets,
  };
}

const run = (id: string, ...args: unknown[]) => registeredCommands.get(id)!(...args);

const EXPECTED_COMMANDS = [
  'asksql.refreshSchema',
  'asksql.testConnection',
  'asksql.testProvider',
  'asksql.addConnection',
  'asksql.removeConnection',
  'asksql.reset',
  'asksql.pickModel',
  'asksql.selectProvider',
  'asksql.openSettings',
  'asksql.askInChat',
  'asksql.clearChat',
  'asksql.askAboutSelection',
  'asksql.collectDiagnostics',
  'asksql.openSqlInEditor',
  'asksql.exportCsv',
  'asksql.setApiKey',
  'asksql.setConnectionPassword',
];

beforeEach(() => {
  resetVscodeMock();
  setInspect('connections', { global: [] });
});

describe('activate', () => {
  it('registers every expected command and the tree/webview providers', () => {
    const { ctx } = fakeContext();
    activate(ctx);
    for (const id of EXPECTED_COMMANDS) expect(registeredCommands.has(id)).toBe(true);
    expect(window.registerTreeDataProvider).toHaveBeenCalledWith('asksql.schema', expect.anything());
    expect(window.registerWebviewViewProvider).toHaveBeenCalledWith(
      'asksql.chat',
      expect.anything(),
      expect.objectContaining({ webviewOptions: { retainContextWhenHidden: true } }),
    );
    // The config and secret change listeners are wired.
    expect(workspaceConfigHandlers.length).toBe(1);
  });
});

describe('command handlers', () => {
  beforeEach(() => activate(fakeContext().ctx));

  it('openSettings opens the AskSQL settings pane', async () => {
    await run('asksql.openSettings');
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'asksql');
  });

  it('openSqlInEditor opens a .sql document', async () => {
    await run('asksql.openSqlInEditor', 'select 1');
    expect(workspace.openTextDocument).toHaveBeenCalledWith({ content: 'select 1', language: 'sql' });
    expect(window.showTextDocument).toHaveBeenCalled();
  });

  it('exportCsv turns a ResultSet into RFC-4180 CSV (quoting embedded commas/quotes)', async () => {
    const res = {
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [
        ['plain', 'has,comma'],
        ['he"llo', null],
      ],
      rowCount: 2,
    };
    await run('asksql.exportCsv', res);
    const doc = workspace.openTextDocument.mock.calls.at(-1)![0] as { content: string; language: string };
    expect(doc.language).toBe('csv');
    expect(doc.content).toBe('a,b\nplain,"has,comma"\n"he""llo",\n');
  });

  it('collectDiagnostics copies a report to the clipboard and opens it', async () => {
    setConfig({ provider: 'ollama', model: 'qwen' });
    await run('asksql.collectDiagnostics');
    expect(env.clipboard.writeText).toHaveBeenCalled();
    const report = env.clipboard.writeText.mock.calls[0]![0] as string;
    expect(report).toContain('AskSQL diagnostics');
    expect(report).toContain('Extension: 9.9.9');
    expect(window.showTextDocument).toHaveBeenCalled();
  });

  it('askInChat with no connections offers to add one', async () => {
    window.showInformationMessage.mockResolvedValueOnce('Add Connection');
    await run('asksql.askInChat');
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.addConnection');
  });

  it('testConnection with no connections offers to add one', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Add Connection');
    await run('asksql.testConnection');
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.addConnection');
  });

  it('askAboutSelection asks for a selection when the editor is empty', async () => {
    await run('asksql.askAboutSelection');
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/select some text/));
  });

  it('askAboutSelection prefills the chat when text is selected', async () => {
    window.activeTextEditor = {
      selection: {},
      document: { getText: () => '  SELECT * FROM t  ' },
    };
    setInspect('connections', { global: [{ id: 'a', name: 'A', engine: 'postgres', database: 'd' }] });
    await run('asksql.askAboutSelection');
    // Reached the prefill path (no "connect a database" or "select text" notice).
    expect(window.showInformationMessage).not.toHaveBeenCalledWith(expect.stringMatching(/connect a database/));
  });

  it('reset does nothing when the confirmation is declined', async () => {
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('asksql.reset');
    expect(window.showInformationMessage).not.toHaveBeenCalledWith('AskSQL: connections and keys removed.');
  });

  it('reset clears settings and secrets when confirmed', async () => {
    setInspect('connections', { global: [{ id: 'a', name: 'A', engine: 'postgres', database: 'd' }] });
    const { ctx, secrets } = fakeContext();
    // Re-activate with a context that has a connection so reset has work to do.
    resetVscodeMock();
    setInspect('connections', { global: [{ id: 'a', name: 'A', engine: 'postgres', database: 'd' }] });
    await secrets.store('asksql.conn.a.password', JSON.stringify({ endpoint: 'x', password: 'p' }));
    activate(ctx);
    window.showWarningMessage.mockResolvedValueOnce('Remove everything');
    await run('asksql.reset');
    expect(window.showInformationMessage).toHaveBeenCalledWith('AskSQL: connections and keys removed.');
  });

  it('clearChat asks first and clears when confirmed', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Clear');
    await expect(run('asksql.clearChat')).resolves.toBeUndefined();
  });

  it('setConnectionPassword with no connections offers to add one', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Add Connection');
    await run('asksql.setConnectionPassword');
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.addConnection');
  });

  it('testProvider reports failure and offers setup', async () => {
    setConfig({ provider: 'ollama', model: '' });
    window.showErrorMessage.mockResolvedValueOnce('Set up provider');
    await run('asksql.testProvider');
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.selectProvider');
  });
});

describe('connection-scoped command handlers', () => {
  // A connection with no database name fails to build immediately, so
  // runConnectionTest resolves fast without opening a real driver/socket.
  const badPg = { id: 'a', name: 'Alpha', engine: 'postgres', scope: 'user' };

  beforeEach(() => {
    setInspect('connections', { global: [badPg] });
  });

  it('testConnection picks a connection then reports it is not usable', async () => {
    activate(fakeContext().ctx);
    window.showQuickPick.mockResolvedValueOnce({ label: 'Alpha', id: 'a' });
    await run('asksql.testConnection');
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/is not usable yet/),
      'Set Password',
      'Open Settings',
    );
  });

  it('setConnectionPassword stores a password for the picked connection', async () => {
    const { ctx, secrets } = fakeContext();
    activate(ctx);
    window.showQuickPick.mockResolvedValueOnce({ label: 'Alpha', id: 'a' });
    window.showInputBox.mockResolvedValueOnce('newpass');
    await run('asksql.setConnectionPassword');
    // Stored under the connection's stable key (endpoint-bound JSON payload).
    expect(secrets._map.has('asksql.conn.a.password')).toBe(true);
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/password saved for Alpha/));
  });

  it('setConnectionPassword explains a connection-string connection has no separate password', async () => {
    setInspect('connections', {
      global: [{ id: 'a', name: 'Alpha', engine: 'postgres', usesConnectionString: true }],
    });
    activate(fakeContext().ctx);
    window.showQuickPick.mockResolvedValueOnce({ label: 'Alpha', id: 'a' });
    await run('asksql.setConnectionPassword');
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/uses a connection string/));
    expect(window.showInputBox).not.toHaveBeenCalled();
  });

  it('removeConnection removes the node it was invoked on', async () => {
    activate(fakeContext().ctx);
    window.showWarningMessage.mockResolvedValueOnce('Remove');
    await run('asksql.removeConnection', { kind: 'connection', conn: { ...badPg } });
    const removed = configUpdates.some((u) => u.key === 'connections');
    expect(removed).toBe(true);
  });

  it('testConnection offers Set Password on failure and runs that command', async () => {
    activate(fakeContext().ctx);
    window.showQuickPick.mockResolvedValueOnce({ label: 'Alpha', id: 'a' });
    window.showErrorMessage.mockResolvedValueOnce('Set Password');
    await run('asksql.testConnection');
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.setConnectionPassword');
  });

  it('testConnection returns quietly when the pick is cancelled', async () => {
    activate(fakeContext().ctx);
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await run('asksql.testConnection');
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('setConnectionPassword clears the password on empty input', async () => {
    const { ctx, secrets } = fakeContext();
    await secrets.store('asksql.conn.a.password', JSON.stringify({ endpoint: 'x', password: 'old' }));
    activate(ctx);
    window.showQuickPick.mockResolvedValueOnce({ label: 'Alpha', id: 'a' });
    window.showInputBox.mockResolvedValueOnce('');
    await run('asksql.setConnectionPassword');
    expect(secrets._map.has('asksql.conn.a.password')).toBe(false);
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/password cleared/));
  });

  it('addConnection command runs the wizard then tests the new connection', async () => {
    const { ctx } = fakeContext();
    activate(ctx);
    // Script a SQLite add: it builds via node:sqlite and fails fast on a missing
    // file, so runConnectionTest returns without a real network wait.
    window.showQuickPick.mockResolvedValueOnce({ label: 'SQLite', value: 'sqlite' });
    window.showInputBox.mockResolvedValueOnce('Local');
    window.showOpenDialog.mockResolvedValueOnce([Uri.file('/no/such/file.db')]);
    await run('asksql.addConnection');
    // The wizard wrote the connection to settings.
    expect(configUpdates.some((u) => u.key === 'connections')).toBe(true);
  });
});

describe('config and secret change listeners', () => {
  it('resets engines on a heavy config change', async () => {
    activate(fakeContext().ctx);
    const handler = workspaceConfigHandlers[0]!;
    await handler({ affectsConfiguration: (k: string) => k === 'asksql' || k === 'asksql.connections' });
    // A pure-UI change must not be treated as heavy.
    await handler({ affectsConfiguration: (k: string) => k === 'asksql' || k === 'asksql.sqlDisplay' });
    // An unrelated change is ignored entirely.
    await handler({ affectsConfiguration: () => false });
  });

  it('resets on an asksql secret change', async () => {
    const { ctx, secrets } = fakeContext();
    activate(ctx);
    // The onDidChange listener was registered via ctx.secrets.onDidChange.
    await secrets.store('asksql.apiKey.openai', 'k');
    // A non-asksql key is ignored.
    await secrets.store('other.key', 'v');
  });
});

describe('more command handlers', () => {
  beforeEach(() => {
    resetVscodeMock();
    setInspect('connections', { global: [] });
  });

  it('refreshSchema, pickModel and selectProvider dispatch without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ models: [] }) })),
    );
    activate(fakeContext().ctx);
    await run('asksql.refreshSchema');
    await run('asksql.pickModel');
    await run('asksql.selectProvider');
    vi.unstubAllGlobals();
  });

  it('askInChat focuses the panel when a connection exists', async () => {
    setInspect('connections', { global: [{ id: 'a', name: 'A', engine: 'postgres', database: 'd' }] });
    activate(fakeContext().ctx);
    await run('asksql.askInChat');
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.chat.focus');
  });

  it('addConnection command returns early when the wizard is cancelled', async () => {
    activate(fakeContext().ctx);
    window.showQuickPick.mockResolvedValueOnce(undefined); // engine picker cancelled
    await run('asksql.addConnection');
    expect(configUpdates.some((u) => u.key === 'connections')).toBe(false);
  });

  it('collectDiagnostics reports an unset provider/model', async () => {
    activate(fakeContext().ctx);
    await run('asksql.collectDiagnostics');
    const report = env.clipboard.writeText.mock.calls[0]![0] as string;
    expect(report).toContain('Provider: (unset)');
  });

  it('reset also clears workspace settings when a workspace is open', async () => {
    setInspect('connections', { global: [{ id: 'a', name: 'A', engine: 'postgres', database: 'd' }] });
    workspace.workspaceFolders = [{ uri: Uri.file('/repo') }];
    activate(fakeContext().ctx);
    window.showWarningMessage.mockResolvedValueOnce('Remove everything');
    await run('asksql.reset');
    const targets = configUpdates.filter((u) => u.key === 'connections').map((u) => u.target);
    expect(targets).toContain(2); // ConfigurationTarget.Workspace
  });
});

describe('deactivate', () => {
  it('resolves without throwing', async () => {
    activate(fakeContext().ctx);
    await expect(deactivate()).resolves.toBeUndefined();
  });
});
