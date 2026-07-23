import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetVscodeMock,
  setInspect,
  configUpdates,
  createSecretStorage,
  setWorkspaceFolders,
  window,
  workspace,
  Uri,
  ConfigurationTarget,
} from './vscode-mock.js';
import { addConnection, removeConnection } from '../src/wizard.js';
import {
  passwordKey,
  connectionStringKey,
  readConnectionString,
  readPassword,
  type ConnectionConfig,
} from '../src/engine.js';

beforeEach(() => {
  resetVscodeMock();
  // No workspace by default, so pickTarget resolves straight to user settings.
  setWorkspaceFolders(undefined);
});

/** The connections written by the last connections update. */
function lastConnectionsWrite(): ConnectionConfig[] | undefined {
  const w = [...configUpdates].reverse().find((u) => u.key === 'connections');
  return w?.value as ConnectionConfig[] | undefined;
}

describe('addConnection', () => {
  it('adds a Postgres connection from discrete fields with SSL and password', async () => {
    window.showQuickPick
      .mockResolvedValueOnce({ label: 'PostgreSQL', value: 'postgres' }) // engine
      .mockResolvedValueOnce({ label: 'Enter connection details', value: 'fields' }) // method
      .mockResolvedValueOnce({ label: 'SSL, verify certificate', value: 'verify' }); // ssl
    window.showInputBox
      .mockResolvedValueOnce('Prod') // name
      .mockResolvedValueOnce('db.example.com') // host
      .mockResolvedValueOnce('5432') // port
      .mockResolvedValueOnce('appuser') // user
      .mockResolvedValueOnce('appdb') // database
      .mockResolvedValueOnce('s3cret'); // password
    const secrets = createSecretStorage();

    const id = await addConnection(secrets as never);
    expect(id).toBe('prod');
    const written = lastConnectionsWrite()!;
    expect(written[0]).toMatchObject({
      id: 'prod',
      engine: 'postgres',
      host: 'db.example.com',
      port: 5432,
      user: 'appuser',
      database: 'appdb',
      ssl: 'verify',
    });
    // Password went to the keychain (endpoint-bound), never to settings.
    expect(await readPassword(secrets as never, written[0]!)).toBe('s3cret');
    expect((written[0] as { password?: string }).password).toBeUndefined();
  });

  it('adds a Postgres connection from a pasted DSN, storing it in the keychain', async () => {
    window.showQuickPick
      .mockResolvedValueOnce({ label: 'PostgreSQL', value: 'postgres' })
      .mockResolvedValueOnce({ label: 'Paste a connection string', value: 'dsn' });
    window.showInputBox
      .mockResolvedValueOnce('Cloud') // name
      .mockResolvedValueOnce('postgres://u:p@host:5432/db'); // dsn
    const secrets = createSecretStorage();

    const id = await addConnection(secrets as never);
    expect(id).toBe('cloud');
    const written = lastConnectionsWrite()!;
    expect(written[0]).toMatchObject({ id: 'cloud', engine: 'postgres', usesConnectionString: true });
    // The DSN is stored scope-bound in the keychain, not raw.
    expect(await readConnectionString(secrets as never, 'cloud', 'user')).toBe('postgres://u:p@host:5432/db');
  });

  it('adds an Oracle connection with no SSL step', async () => {
    window.showQuickPick
      .mockResolvedValueOnce({ label: 'Oracle', value: 'oracle' })
      .mockResolvedValueOnce({ label: 'Enter connection details', value: 'fields' });
    window.showInputBox
      .mockResolvedValueOnce('OraDB') // name
      .mockResolvedValueOnce('orahost') // host
      .mockResolvedValueOnce('1521') // port
      .mockResolvedValueOnce('system') // user
      .mockResolvedValueOnce('ORCL') // service name
      .mockResolvedValueOnce('pw'); // password
    const secrets = createSecretStorage();

    const id = await addConnection(secrets as never);
    const written = lastConnectionsWrite()!;
    expect(written[0]).toMatchObject({ id, engine: 'oracle', database: 'ORCL' });
    expect((written[0] as { ssl?: string }).ssl).toBeUndefined();
  });

  it('adds a SQLite connection from a picked file', async () => {
    window.showQuickPick.mockResolvedValueOnce({ label: 'SQLite', value: 'sqlite' });
    window.showInputBox.mockResolvedValueOnce('Local'); // name
    window.showOpenDialog.mockResolvedValueOnce([Uri.file('/data/local.db')]);
    const secrets = createSecretStorage();

    const id = await addConnection(secrets as never);
    const written = lastConnectionsWrite()!;
    expect(written[0]).toMatchObject({ id, engine: 'sqlite', file: '/data/local.db' });
  });

  it('adds a MongoDB connection with a DSN and database name', async () => {
    window.showQuickPick.mockResolvedValueOnce({ label: 'MongoDB', value: 'mongodb' });
    window.showInputBox
      .mockResolvedValueOnce('Shop') // name
      .mockResolvedValueOnce('mongodb+srv://u:p@cluster.example.net') // dsn
      .mockResolvedValueOnce('shopdb'); // database
    const secrets = createSecretStorage();

    const id = await addConnection(secrets as never);
    const written = lastConnectionsWrite()!;
    expect(written[0]).toMatchObject({ id, engine: 'mongodb', database: 'shopdb', usesConnectionString: true });
    expect(await readConnectionString(secrets as never, id!, 'user')).toBe('mongodb+srv://u:p@cluster.example.net');
  });

  it('generates a unique id when the derived id is taken', async () => {
    setInspect('connections', { global: [{ id: 'prod', name: 'Prod', engine: 'postgres', database: 'd' }] });
    window.showQuickPick
      .mockResolvedValueOnce({ label: 'PostgreSQL', value: 'postgres' })
      .mockResolvedValueOnce({ label: 'Paste a connection string', value: 'dsn' });
    window.showInputBox.mockResolvedValueOnce('Prod').mockResolvedValueOnce('postgres://u:p@h/db');
    const secrets = createSecretStorage();
    expect(await addConnection(secrets as never)).toBe('prod_2');
  });

  it('cancels when the engine picker is dismissed', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage();
    expect(await addConnection(secrets as never)).toBeUndefined();
    expect(configUpdates.find((u) => u.key === 'connections')).toBeUndefined();
  });

  it('cancels when the name is empty', async () => {
    window.showQuickPick.mockResolvedValueOnce({ label: 'PostgreSQL', value: 'postgres' });
    window.showInputBox.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage();
    expect(await addConnection(secrets as never)).toBeUndefined();
  });

  it('prompts to choose a target when a workspace is open and honours user settings', async () => {
    setWorkspaceFolders([{ uri: Uri.file('/repo') }]);
    window.showQuickPick
      .mockResolvedValueOnce({ label: 'PostgreSQL', value: 'postgres' })
      .mockResolvedValueOnce({ label: 'Paste a connection string', value: 'dsn' })
      .mockResolvedValueOnce({ label: 'User settings', target: ConfigurationTarget.Global });
    window.showInputBox.mockResolvedValueOnce('Prod').mockResolvedValueOnce('postgres://u:p@h/db');
    const secrets = createSecretStorage();

    const id = await addConnection(secrets as never);
    expect(id).toBe('prod');
    const write = [...configUpdates].reverse().find((u) => u.key === 'connections')!;
    expect(write.target).toBe(ConfigurationTarget.Global);
  });

  it('cancels when the save-target picker is dismissed', async () => {
    setWorkspaceFolders([{ uri: Uri.file('/repo') }]);
    window.showQuickPick
      .mockResolvedValueOnce({ label: 'PostgreSQL', value: 'postgres' })
      .mockResolvedValueOnce({ label: 'Paste a connection string', value: 'dsn' })
      .mockResolvedValueOnce(undefined); // target
    window.showInputBox.mockResolvedValueOnce('Prod').mockResolvedValueOnce('postgres://u:p@h/db');
    const secrets = createSecretStorage();
    expect(await addConnection(secrets as never)).toBeUndefined();
  });
});

describe('inline field validation', () => {
  /** Find the options object of a showInputBox call by its prompt. */
  const optsByPrompt = (re: RegExp) =>
    window.showInputBox.mock.calls
      .map((c) => c[0] as { prompt?: string; validateInput?: (v: string) => string | undefined })
      .find((o) => o.prompt && re.test(o.prompt))!;

  it('validates the port and required database on the MySQL fields path', async () => {
    window.showQuickPick
      .mockResolvedValueOnce({ label: 'MySQL / MariaDB', value: 'mysql' })
      .mockResolvedValueOnce({ label: 'Enter connection details', value: 'fields' })
      .mockResolvedValueOnce({ label: 'No SSL', value: undefined });
    window.showInputBox
      .mockResolvedValueOnce('My') // name
      .mockResolvedValueOnce('h') // host
      .mockResolvedValueOnce('3306') // port
      .mockResolvedValueOnce('root') // user
      .mockResolvedValueOnce('shop') // database
      .mockResolvedValueOnce('pw'); // password
    const secrets = createSecretStorage();
    await addConnection(secrets as never);

    const port = optsByPrompt(/^Port$/).validateInput!;
    expect(port('abc')).toMatch(/between 1 and 65535/);
    expect(port('70000')).toMatch(/between 1 and 65535/);
    expect(port('3306')).toBeUndefined();

    const db = optsByPrompt(/schema to query/).validateInput!;
    expect(db('   ')).toMatch(/required/);
    expect(db('shop')).toBeUndefined();
  });

  it('validates a pasted Postgres DSN scheme', async () => {
    window.showQuickPick
      .mockResolvedValueOnce({ label: 'PostgreSQL', value: 'postgres' })
      .mockResolvedValueOnce({ label: 'Paste a connection string', value: 'dsn' });
    window.showInputBox.mockResolvedValueOnce('P').mockResolvedValueOnce('postgres://u:p@h/db');
    const secrets = createSecretStorage();
    await addConnection(secrets as never);

    const dsn = optsByPrompt(/Connection string/).validateInput!;
    expect(dsn('  ')).toMatch(/required/);
    expect(dsn('mysql://x')).toMatch(/Expected a postgres/);
    expect(dsn('notaurl')).toMatch(/does not look like/);
    expect(dsn('postgres://u:p@h/db')).toBeUndefined();
  });

  it('offers Oracle discrete fields only - no connection-string method prompt', async () => {
    window.showQuickPick.mockResolvedValueOnce({ label: 'Oracle', value: 'oracle' });
    window.showInputBox
      .mockResolvedValueOnce('O') // name
      .mockResolvedValueOnce('h') // host
      .mockResolvedValueOnce('1521') // port
      .mockResolvedValueOnce('system') // user
      .mockResolvedValueOnce('ORCL') // service name
      .mockResolvedValueOnce('pw'); // password
    const secrets = createSecretStorage();
    await addConnection(secrets as never);
    // Only the engine picker fired: Oracle skips the fields-vs-connection-string step.
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(lastConnectionsWrite()![0]).toMatchObject({ engine: 'oracle', database: 'ORCL' });
  });

  it('validates the MongoDB connection-string scheme', async () => {
    window.showQuickPick.mockResolvedValueOnce({ label: 'MongoDB', value: 'mongodb' });
    window.showInputBox
      .mockResolvedValueOnce('M')
      .mockResolvedValueOnce('mongodb://u:p@h:27017')
      .mockResolvedValueOnce('shop');
    const secrets = createSecretStorage();
    await addConnection(secrets as never);
    const dsn = optsByPrompt(/mongodb\+srv/).validateInput!;
    expect(dsn('  ')).toMatch(/required/);
    expect(dsn('http://x')).toMatch(/mongodb:\/\/ or mongodb\+srv/);
    expect(dsn('mongodb://h')).toBeUndefined();
  });
});

describe('removeConnection', () => {
  it('returns false when there are no connections', async () => {
    setInspect('connections', { global: [] });
    const secrets = createSecretStorage();
    expect(await removeConnection(secrets as never)).toBe(false);
  });

  it('removes a connection by id, clearing its secrets from every scope', async () => {
    setInspect('connections', {
      global: [{ id: 'a', name: 'A', engine: 'postgres', database: 'd' }],
      workspace: [{ id: 'a', name: 'A', engine: 'postgres', database: 'd' }],
    });
    setWorkspaceFolders([{ uri: Uri.file('/repo') }]);
    window.showWarningMessage.mockResolvedValueOnce('Remove');
    const secrets = createSecretStorage({ [passwordKey('a')]: 'pw', [connectionStringKey('a')]: 'dsn' });

    const removed = await removeConnection(secrets as never, 'a');
    expect(removed).toBe(true);
    // Written to both scopes with the entry filtered out.
    const targets = configUpdates.filter((u) => u.key === 'connections').map((u) => u.target);
    expect(targets).toContain(ConfigurationTarget.Workspace);
    expect(targets).toContain(ConfigurationTarget.Global);
    expect(secrets._map.has(passwordKey('a'))).toBe(false);
    expect(secrets._map.has(connectionStringKey('a'))).toBe(false);
  });

  it('prompts to pick when no id is passed', async () => {
    setInspect('connections', { global: [{ id: 'a', name: 'Alpha', engine: 'mysql', database: 'd' }] });
    window.showQuickPick.mockResolvedValueOnce({ label: 'Alpha', id: 'a' });
    window.showWarningMessage.mockResolvedValueOnce('Remove');
    const secrets = createSecretStorage();
    expect(await removeConnection(secrets as never)).toBe(true);
  });

  it('returns false when the confirmation is declined', async () => {
    setInspect('connections', { global: [{ id: 'a', name: 'A', engine: 'mysql', database: 'd' }] });
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage();
    expect(await removeConnection(secrets as never, 'a')).toBe(false);
    expect(configUpdates.find((u) => u.key === 'connections')).toBeUndefined();
  });

  it('returns false when the pick is cancelled', async () => {
    setInspect('connections', { global: [{ id: 'a', name: 'A', engine: 'mysql', database: 'd' }] });
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage();
    expect(await removeConnection(secrets as never)).toBe(false);
  });

  it('returns false for an unknown id', async () => {
    setInspect('connections', { global: [{ id: 'a', name: 'A', engine: 'mysql', database: 'd' }] });
    const secrets = createSecretStorage();
    expect(await removeConnection(secrets as never, 'nope')).toBe(false);
  });
});
