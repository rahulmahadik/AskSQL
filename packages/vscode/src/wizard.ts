/**
 * Guided "Add connection" flow.
 *
 * Hand-editing settings.json is not a setup experience, and it tempts people to
 * paste a password into a synced file. This walks the user through it and puts
 * the password straight into the OS keychain instead.
 */

import * as vscode from 'vscode';
import {
  connectionConfigs,
  passwordKey,
  connectionStringKey,
  storePassword,
  storeConnectionString,
  type ConnectionConfig,
  type ConnectionScope,
} from './engine.js';
import { DEFAULT_PORT } from './constants.js';


/** Settings id: stable, unique, and safe to use as a secret key. */
function makeId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'db';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now()}`;
}

const ask = (prompt: string, value?: string, password = false): Thenable<string | undefined> =>
  vscode.window.showInputBox({ prompt, value, password, ignoreFocusOut: true });

/**
 * Ask for a value that must not be blank.
 *
 * An empty database name was accepted and then CONNECTED fine - Postgres and
 * MySQL are happy to open a session with no default schema - so introspection
 * returned zero tables and the tree just said "No tables found". The user is
 * left thinking AskSQL cannot see their data. Refuse the blank instead.
 */
const askRequired = (prompt: string, value?: string): Thenable<string | undefined> =>
  vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'This is required.'),
  });

/**
 * Where to save the connection.
 *
 * Never decide this silently: workspace settings live in the project's
 * .vscode/settings.json, which is usually committed - so a "quick add" would
 * quietly publish someone's host and username to their team's repo. Ask, and
 * default to user settings, which stay private to the machine.
 */
async function pickTarget(): Promise<vscode.ConfigurationTarget | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) return vscode.ConfigurationTarget.Global;
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'User settings',
        description: 'Recommended - private to you, available in every project',
        target: vscode.ConfigurationTarget.Global,
      },
      {
        label: 'Workspace settings',
        description: 'Saved in this project\'s .vscode/settings.json (shared if you commit it)',
        target: vscode.ConfigurationTarget.Workspace,
      },
    ],
    { placeHolder: 'Where should this connection be saved?', ignoreFocusOut: true },
  );
  if (!pick) return undefined;

  // Workspace settings live in the project's .vscode/settings.json, which is
  // usually committed. A one-line quick-pick description is not informed
  // consent: spell out exactly what other people would see, and let them back
  // out to the safe option from here.
  if (pick.target === vscode.ConfigurationTarget.Workspace) {
    const choice = await vscode.window.showWarningMessage(
      'Save this connection in the project?',
      {
        modal: true,
        detail:
          "It goes in this project's .vscode/settings.json. If that file is committed, everyone with the repository sees the host, port, user name, and database name.\n\n" +
          'Your password is never written there. It stays in your OS keychain either way.',
      },
      'Save in project',
      'Save in user settings instead',
    );
    if (choice === 'Save in user settings instead') return vscode.ConfigurationTarget.Global;
    if (choice !== 'Save in project') return undefined;
  }
  return pick.target;
}

/**
 * Every scope that defines this id.
 *
 * Removing from just one is not a removal: the same id can be defined at user
 * AND workspace level, and taking it out of one simply reveals the other. The
 * user confirmed "remove this connection", so it goes from everywhere.
 */
function scopesDefining(id: string): vscode.ConfigurationTarget[] {
  const info = vscode.workspace.getConfiguration('asksql').inspect<ConnectionConfig[]>('connections');
  const out: vscode.ConfigurationTarget[] = [];
  if (info?.workspaceValue?.some((c) => c.id === id)) out.push(vscode.ConfigurationTarget.Workspace);
  if (info?.globalValue?.some((c) => c.id === id)) out.push(vscode.ConfigurationTarget.Global);
  return out;
}

/** The connections defined in one scope (not the merged view). */
function scopeValue(t: vscode.ConfigurationTarget): ConnectionConfig[] {
  const info = vscode.workspace.getConfiguration('asksql').inspect<ConnectionConfig[]>('connections');
  if (t === vscode.ConfigurationTarget.Workspace) return info?.workspaceValue ?? [];
  return info?.globalValue ?? [];
}

export async function addConnection(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const engine = await vscode.window.showQuickPick(
    [
      { label: 'PostgreSQL', value: 'postgres' as const },
      { label: 'MySQL / MariaDB', value: 'mysql' as const },
      { label: 'SQLite', value: 'sqlite' as const, description: 'a .db file' },
    ],
    { placeHolder: 'Which database?', ignoreFocusOut: true },
  );
  if (!engine) return undefined;

  const name = await ask('Display name', engine.label);
  if (!name) return undefined;

  const existing = connectionConfigs();
  const id = makeId(name, new Set(existing.map((c) => c.id)));
  let conn: ConnectionConfig;
  let password: string | undefined;
  let connectionString: string | undefined;

  if (engine.value === 'sqlite') {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Use this database',
      filters: { 'SQLite database': ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] },
    });
    if (!picked?.[0]) return undefined;
    conn = { id, name, engine: 'sqlite', file: picked[0].fsPath };
  } else {
    // Two ways in: paste a full connection string (the fast path for a cloud
    // database that hands you one), or fill in host/port/user/etc. by hand.
    const method = await vscode.window.showQuickPick(
      [
        { label: 'Enter connection details', value: 'fields' as const },
        {
          label: 'Paste a connection string',
          value: 'dsn' as const,
          description: 'host, user, password and SSL in one line - e.g. from Supabase, Neon, RDS, PlanetScale',
        },
      ],
      { placeHolder: `How do you want to connect to ${engine.label}?`, ignoreFocusOut: true },
    );
    if (!method) return undefined;

    if (method.value === 'dsn') {
      const schemes = engine.value === 'postgres' ? ['postgres:', 'postgresql:'] : ['mysql:', 'mariadb:'];
      // Masked (it carries the password) + validated against the chosen engine.
      const dsn = await vscode.window.showInputBox({
        prompt: engine.value === 'postgres'
          ? 'Connection string, e.g. postgres://user:password@host:5432/dbname?sslmode=require'
          : 'Connection string, e.g. mysql://user:password@host:3306/dbname',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => {
          const t = v.trim();
          if (!t) return 'This is required.';
          const scheme = /^([a-zA-Z][\w+.-]*:)/.exec(t)?.[1]?.toLowerCase();
          if (!scheme) return 'This does not look like a connection string (expected scheme://...).';
          if (!schemes.includes(scheme)) return `Expected a ${schemes[0]}// URL for ${engine.label}, got ${scheme}//`;
          return undefined;
        },
      });
      if (!dsn?.trim()) return undefined;
      connectionString = dsn.trim();
      // The DSN (with credentials) goes to the keychain; settings holds only the marker.
      conn = { id, name, engine: engine.value, usesConnectionString: true };
    } else {
      const host = await ask('Host', 'localhost');
      if (host === undefined) return undefined;
      // Validate inline (1-65535) so a typo is corrected in place, not by aborting
      // the whole wizard and making the user start over.
      const portStr = await vscode.window.showInputBox({
        prompt: 'Port',
        value: String(DEFAULT_PORT[engine.value] ?? ''),
        ignoreFocusOut: true,
        validateInput: (v) => {
          const n = Number(v.trim());
          return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : 'Enter a port between 1 and 65535.';
        },
      });
      if (portStr === undefined) return undefined;
      const port = Number(portStr.trim());
      const user = await ask('User', engine.value === 'postgres' ? 'postgres' : 'root');
      if (user === undefined) return undefined;
      const database = await askRequired(
        engine.value === 'postgres' ? 'Database name (the database to query)' : 'Database name (the schema to query)',
      );
      if (!database?.trim()) return undefined;
      password = await ask('Password (stored in your OS keychain, not in settings)', '', true);
      if (password === undefined) return undefined;
      // Most cloud databases refuse a plain connection; local ones do not need SSL.
      const sslPick = await vscode.window.showQuickPick(
        [
          { label: 'No SSL', description: 'Plain connection - fine for local or private-network databases', value: undefined },
          { label: 'SSL, verify certificate', description: 'Encrypted and authenticated - use for managed cloud databases (RDS, Supabase, Neon, ...)', value: 'verify' as const },
          { label: 'SSL, do not verify certificate', description: 'Encrypted but not authenticated - for self-signed or self-hosted servers', value: 'no-verify' as const },
        ],
        { placeHolder: 'SSL/TLS for this connection?', ignoreFocusOut: true },
      );
      if (!sslPick) return undefined;
      conn = { id, name, engine: engine.value, host: host || 'localhost', port, user, database, ...(sslPick.value ? { ssl: sslPick.value } : {}) };
    }
  }

  const scope = await pickTarget();
  if (!scope) return undefined;
  const connScope: ConnectionScope = scope === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user';
  // Store secrets BEFORE writing the settings entry: the settings change triggers
  // a connector rebuild, and a rebuild that races ahead of the secret would record
  // a spurious "no password/connection string" failure. A secret with no settings
  // entry is inert; the reverse is not.
  if (password) await storePassword(secrets, conn, password);
  if (connectionString) await storeConnectionString(secrets, id, connectionString, connScope);
  await vscode.workspace
    .getConfiguration('asksql')
    .update('connections', [...scopeValue(scope), conn], scope);

  return id;
}

/** Remove a connection (and forget its password). */
export async function removeConnection(secrets: vscode.SecretStorage, id?: string): Promise<boolean> {
  const existing = connectionConfigs();
  if (existing.length === 0) return false;

  let targetId = id;
  if (!targetId) {
    const pick = await vscode.window.showQuickPick(
      existing.map((c) => ({ label: c.name, description: `${c.engine} (${c.id})`, id: c.id })),
      { placeHolder: 'Remove which connection?', ignoreFocusOut: true },
    );
    if (!pick) return false;
    targetId = pick.id;
  }

  const conn = existing.find((c) => c.id === targetId);
  if (!conn) return false;
  const yes = await vscode.window.showWarningMessage(
    `Remove "${conn.name}" from AskSQL?`,
    { modal: true },
    'Remove',
  );
  if (yes !== 'Remove') return false;

  const scopes = scopesDefining(targetId);
  for (const scope of scopes) {
    await vscode.workspace
      .getConfiguration('asksql')
      .update('connections', scopeValue(scope).filter((c) => c.id !== targetId), scope);
  }
  // One stable key per id, so this always finds the secrets. Nothing is left in
  // the OS keychain after a connection is removed - password (discrete mode) and
  // connection string (DSN mode) are both cleared regardless of which was used.
  await secrets.delete(passwordKey(targetId));
  await secrets.delete(connectionStringKey(targetId));
  return scopes.length > 0;
}
