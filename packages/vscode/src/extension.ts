/**
 * AskSQL for VS Code.
 *
 * One surface, entirely ours:
 *  - the AskSQL panel (its own webview view, themed from VS Code's variables)
 *  - a TreeView schema explorer beneath it
 *  - generated SQL opens in a real .sql editor
 *
 * There is deliberately no chat participant. A participant can only live inside
 * VS Code's shared chat panel, which forces an `@asksql` mention, VS Code's own
 * model dropdown listing Copilot and Claude, and that panel's settings. None of
 * that is ours to restyle, so the product read as a guest in someone else's UI.
 *
 * The engine, the guard, and every credential stay in the extension host. The
 * webview renders and nothing more.
 */

import * as vscode from 'vscode';
import type { ResultSet } from '@asksql/core';
import { EngineManager, apiKeyKey, storePassword, passwordKey, connectionStringKey, connectionConfigs } from './engine.js';
import { ChatViewProvider } from './chatView.js';
import { SchemaTreeProvider, type Node } from './tree.js';
import { addConnection, removeConnection } from './wizard.js';
import { selectModel, selectProvider } from './models.js';
import { initLog, log } from './log.js';
import { userMessage } from './errors.js';

let engines: EngineManager | undefined;

/** Wrap a command so an unexpected failure surfaces as a plain message, not a raw VS Code error. */
function guard<A extends unknown[]>(fn: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      log.error('command failed', err);
      void vscode.window.showErrorMessage(`AskSQL: ${userMessage(err)}`);
    }
  };
}

/**
 * Minimal RFC-4180 CSV. Deliberately local: the host has no UI, so pulling in
 * the React package just for a helper would drag React into this bundle.
 */
function toCsv(res: ResultSet): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = res.columns.map((c) => esc(c.name)).join(',');
  const body = res.rows.map((r) => r.map(esc).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

/**
 * Connect for real, read the schema, and report the outcome in plain language.
 *
 * Shared by "Add Connection" (which tests what it just saved) and the explicit
 * Test command, so both give the identical verdict.
 */
async function runConnectionTest(id: string): Promise<void> {
  const conn = connectionConfigs().find((c) => c.id === id);
  if (!conn || !engines) return;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `AskSQL: testing "${conn.name}"...` },
    () => engines!.testConnection(id),
  );
  if (result.ok && result.tables > 0) {
    void vscode.window.showInformationMessage(
      `AskSQL: "${conn.name}" is ready - ${result.tables} table${result.tables === 1 ? '' : 's'}. Ask it something in the AskSQL panel.`,
    );
    return;
  }
  if (result.ok) {
    void vscode.window.showWarningMessage(
      `AskSQL: connected to "${conn.name}", but found no tables this user can read. Check the database name and the user's permissions.`,
    );
    return;
  }
  const pick = await vscode.window.showErrorMessage(
    `AskSQL: "${conn.name}" is not usable yet. ${result.message}`,
    'Set Password',
    'Open Settings',
  );
  if (pick === 'Set Password') await vscode.commands.executeCommand('asksql.setConnectionPassword');
  if (pick === 'Open Settings') await vscode.commands.executeCommand('asksql.openSettings');
}

export function activate(ctx: vscode.ExtensionContext): void {
  initLog(ctx);
  engines = new EngineManager(ctx.secrets);
  const tree = new SchemaTreeProvider(engines);
  const chat = new ChatViewProvider(ctx, engines);

  ctx.subscriptions.push(
    engines,
    tree,
    vscode.window.registerTreeDataProvider('asksql.schema', tree),
    // retainContextWhenHidden: a conversation that vanishes when the panel is
    // collapsed is not a conversation.
    vscode.window.registerWebviewViewProvider('asksql.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    /**
     * SecretStorage is shared across windows, so a password changed in another
     * window must invalidate the connectors this one is holding - otherwise this
     * window keeps failing to authenticate until it is reloaded.
     */
    ctx.secrets.onDidChange(async (e) => {
      if (!e.key.startsWith('asksql.')) return;
      await engines?.reset();
      tree.refresh();
      chat.refresh();
    }),

    vscode.commands.registerCommand('asksql.refreshSchema', () => tree.refresh()),

    /**
     * Connect for real and read the schema, then say what happened.
     *
     * "It saved but the tree is empty" is the single hardest thing to diagnose
     * from the outside, so make the extension answer it directly.
     */
    vscode.commands.registerCommand('asksql.testConnection', async (node?: Node) => {
      const conns = connectionConfigs();
      if (conns.length === 0) {
        const add = await vscode.window.showWarningMessage('AskSQL: connect a database first.', 'Add Connection');
        if (add) await vscode.commands.executeCommand('asksql.addConnection');
        return;
      }
      let id = node?.kind === 'connection' ? node.conn.id : undefined;
      if (!id) {
        const pick = await vscode.window.showQuickPick(
          conns.map((c) => ({ label: c.name, description: `${c.engine} (${c.scope} settings)`, id: c.id })),
          { placeHolder: 'Test which connection?' },
        );
        if (!pick) return;
        id = pick.id;
      }
      await runConnectionTest(id);
      tree.refresh();
    }),

    /**
     * Ask the configured provider one trivial question.
     *
     * Only meaningful for the bring-your-own-LLM path; the VS Code chat model
     * needs no test because VS Code owns it and reports its own errors.
     */
    vscode.commands.registerCommand('asksql.testProvider', async () => {
      const provider = vscode.workspace.getConfiguration('asksql').get<string>('provider') ?? 'ollama';
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `AskSQL: testing ${provider}...` },
        () => engines!.testProvider(),
      );
      if (result.ok) {
        void vscode.window.showInformationMessage(`AskSQL: ${provider} answered "${result.reply}". It is working.`);
      } else {
        const pick = await vscode.window.showErrorMessage(
          `AskSQL: ${provider} did not answer. ${result.message}`,
          'Select Model',
          'Open Settings',
        );
        if (pick === 'Select Model') await vscode.commands.executeCommand('asksql.selectModel');
        if (pick === 'Open Settings') await vscode.commands.executeCommand('asksql.openSettings');
      }
    }),

    vscode.commands.registerCommand('asksql.addConnection', guard(async () => {
      // The settings write fires onDidChangeConfiguration, which resets engines.
      const id = await addConnection(ctx.secrets);
      if (!id) return;
      tree.refresh();
      chat.refresh();
      // Test immediately so a wrong password/host surfaces now, not on first query.
      await runConnectionTest(id);
    })),

    // Invoked from the tree's context menu (node passed) or the palette (no arg).
    vscode.commands.registerCommand('asksql.removeConnection', guard(async (node?: Node) => {
      const id = node?.kind === 'connection' ? node.conn.id : undefined;
      if (await removeConnection(ctx.secrets, id)) tree.refresh();
    })),

    /**
     * A clean slate. Connections live in settings and passwords/keys in the OS
     * keychain, and both survive an extension uninstall by design - this is the way
     * to actually clear them.
     */
    vscode.commands.registerCommand('asksql.reset', guard(async () => {
      const conns = connectionConfigs();
      const yes = await vscode.window.showWarningMessage(
        'Remove all AskSQL connections and keys?',
        {
          modal: true,
          detail:
            `This removes the ${conns.length} connection${conns.length === 1 ? '' : 's'} configured in this window from settings, deletes their saved database passwords and connection strings plus every AI provider API key from your OS keychain, and forgets the selected model. It cannot be undone.`,
        },
        'Remove everything',
      );
      if (yes !== 'Remove everything') return;
      const cfg = vscode.workspace.getConfiguration('asksql');
      await cfg.update('connections', undefined, vscode.ConfigurationTarget.Global);
      if (vscode.workspace.workspaceFolders?.length) {
        await cfg.update('connections', undefined, vscode.ConfigurationTarget.Workspace);
      }
      for (const c of conns) {
        await ctx.secrets.delete(passwordKey(c.id));
        await ctx.secrets.delete(connectionStringKey(c.id));
      }
      for (const p of ['ollama', 'openai', 'anthropic', 'google', 'groq', 'openai-compatible']) {
        await ctx.secrets.delete(apiKeyKey(p));
      }
      await ctx.globalState.update('asksql.modelChoice', undefined);
      // Settings + secret changes fire the reset listeners; refresh to be sure.
      await engines?.reset();
      tree.refresh();
      chat.refresh();
      void vscode.window.showInformationMessage('AskSQL: connections and keys removed.');
    })),

    vscode.commands.registerCommand('asksql.selectModel', async () => {
      await selectModel(ctx.secrets);
    }),

    // The unified "which model answers" picker (VS Code chat model or your provider).
    vscode.commands.registerCommand('asksql.pickModel', guard(() => chat.pickModel())),

    vscode.commands.registerCommand('asksql.selectProvider', async () => {
      await selectProvider(ctx.secrets);
    }),

    vscode.commands.registerCommand('asksql.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'asksql'),
    ),

    /** Focus our own panel. Never opens VS Code's shared chat. */
    vscode.commands.registerCommand('asksql.askInChat', async () => {
      if (connectionConfigs().length === 0) {
        const add = await vscode.window.showInformationMessage('AskSQL: connect a database first.', 'Add Connection');
        if (add) await vscode.commands.executeCommand('asksql.addConnection');
        return;
      }
      chat.focus();
    }),

    /** Clearing throws away the conversation, so it asks first. */
    vscode.commands.registerCommand('asksql.clearChat', async () => {
      const yes = await vscode.window.showWarningMessage(
        'Clear the AskSQL conversation?',
        { modal: true, detail: 'The questions and results in the panel are removed. Your connections and settings are untouched.' },
        'Clear',
      );
      if (yes === 'Clear') chat.clear();
    }),

    /** Chat hands the generated SQL here so the user keeps it in a real editor. */
    vscode.commands.registerCommand('asksql.openSqlInEditor', async (sql: string) => {
      const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('asksql.exportCsv', async (res: ResultSet) => {
      const csv = toCsv(res);
      const doc = await vscode.workspace.openTextDocument({ content: csv, language: 'csv' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('asksql.setApiKey', guard(async () => {
      const provider = vscode.workspace.getConfiguration('asksql').get<string>('provider') ?? 'ollama';
      const key = await vscode.window.showInputBox({
        prompt: `API key for ${provider} (stored in your OS keychain, never in settings)`,
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      // secrets.onDidChange resets the engines.
      if (key) await ctx.secrets.store(apiKeyKey(provider), key);
      else await ctx.secrets.delete(apiKeyKey(provider));
      void vscode.window.showInformationMessage(
        key ? `AskSQL: API key saved for ${provider}.` : `AskSQL: API key cleared for ${provider}.`,
      );
    })),

    /**
     * Takes the clicked node when invoked from the tree's key icon. Asking
     * "which database?" right after the user clicked one is both noise and a way
     * to save the password against the wrong connection.
     */
    vscode.commands.registerCommand('asksql.setConnectionPassword', guard(async (node?: Node) => {
      const conns = connectionConfigs();
      if (conns.length === 0) {
        const add = await vscode.window.showWarningMessage('AskSQL: connect a database first.', 'Add Connection');
        if (add) await vscode.commands.executeCommand('asksql.addConnection');
        return;
      }
      let target = node?.kind === 'connection' ? conns.find((c) => c.id === node.conn.id) : undefined;
      if (!target) {
        const pick = await vscode.window.showQuickPick(
          conns.map((c) => ({ label: c.name, description: `${c.engine} (${c.id})`, id: c.id })),
          { placeHolder: 'Which database?' },
        );
        if (!pick) return;
        target = conns.find((c) => c.id === pick.id);
      }
      if (!target) return;
      // A connection-string connection keeps its password inside the DSN (in the
      // keychain), so there is no separate password to set. Say so instead of
      // silently storing an unused one.
      if (target.usesConnectionString) {
        void vscode.window.showInformationMessage(
          `"${target.name}" uses a connection string, so its password is part of that string. Re-add the connection to change it.`,
        );
        return;
      }
      // Show the endpoint and scope, so a connection injected by a workspace cannot
      // phish the password for a different host behind a familiar display name.
      const where =
        target.engine === 'sqlite'
          ? (target.file ?? '')
          : `${target.host ?? ''}:${target.port ?? ''}/${target.database ?? ''}`;
      const pw = await vscode.window.showInputBox({
        prompt: `Password for ${target.name} - ${target.engine} at ${where} (${target.scope} settings). Stored in your OS keychain.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (pw === undefined) return;
      if (pw) await storePassword(ctx.secrets, target, pw);
      else await ctx.secrets.delete(passwordKey(target.id));
      // secrets.onDidChange resets the engines; nothing to do here but confirm.
      void vscode.window.showInformationMessage(
        pw ? `AskSQL: password saved for ${target.name}.` : `AskSQL: password cleared for ${target.name}.`,
      );
    })),

    // Stale credentials/models must never survive a settings change - but only the
    // settings that connectors/engines actually depend on trigger a rebuild. Pure
    // UI preferences (sqlDisplay, requireApproval) must not tear down live DB pools.
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('asksql')) return;
      const heavy = ['asksql.connections', 'asksql.provider', 'asksql.model', 'asksql.baseURL', 'asksql.maxRows', 'asksql.sampleColumnValues'].some(
        (k) => e.affectsConfiguration(k),
      );
      if (heavy) {
        await engines?.reset();
        tree.refresh();
      }
      chat.refresh();
    }),
  );
}

export async function deactivate(): Promise<void> {
  await engines?.reset();
  engines = undefined;
}
