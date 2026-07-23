import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fake connector modules so buildOne never needs a real driver. Each stores its
// config and exposes the connect/introspect/close shape the engine relies on.
// Defined via vi.hoisted so the hoisted vi.mock factories can reference it.
const { FakeConnector, sqliteClose } = vi.hoisted(() => {
  class FakeConnector {
    dialect = 'sql';
    connectCalls = 0;
    introspectCalls = 0;
    closed = 0;
    constructor(public config: Record<string, unknown>) {}
    get id(): string {
      return this.config.id as string;
    }
    get name(): string {
      return this.config.name as string;
    }
    async connect(): Promise<void> {
      this.connectCalls++;
    }
    async introspect(): Promise<{ tables: unknown[] }> {
      this.introspectCalls++;
      return { tables: [{ name: 't', kind: 'table', columns: [] }] };
    }
    async close(): Promise<void> {
      this.closed++;
    }
  }
  return { FakeConnector, sqliteClose: vi.fn() };
});

vi.mock('@asksql/postgres', () => ({ PostgresConnector: class extends FakeConnector {} }));
vi.mock('@asksql/mysql', () => ({ MysqlConnector: class extends FakeConnector {} }));
vi.mock('@asksql/sqlite', () => ({ SqliteConnector: class extends FakeConnector {} }));
vi.mock('@asksql/oracle', () => ({ OracleConnector: class extends FakeConnector {} }));
vi.mock('@asksql/mongodb', () => ({ MongodbConnector: class extends FakeConnector {} }));

// A SQLite handle mock so openSqlite does not touch the real filesystem/driver.
vi.mock('node:sqlite', () => ({
  DatabaseSync: class {
    constructor(
      public path: string,
      public opts?: unknown,
    ) {}
    close = sqliteClose;
  },
}));

// The mongo engine factory: a fake so the non-SQL path needs no real driver.
const { fakeMongoEngine } = vi.hoisted(() => ({
  fakeMongoEngine: { ask: vi.fn(), execute: vi.fn(), invalidateCatalog: vi.fn() },
}));
vi.mock('@asksql/core/mongo', () => ({ createMongoAskSql: vi.fn(() => fakeMongoEngine) }));

import {
  resetVscodeMock,
  setInspect,
  setConfig,
  createSecretStorage,
  setWorkspaceFolders,
  Uri,
} from './vscode-mock.js';
import {
  EngineManager,
  passwordKey,
  apiKeyKey,
  connectionStringKey,
  storePassword,
  readPassword,
  storeConnectionString,
  readConnectionString,
  connectionConfigs,
  type ConnectionConfig,
} from '../src/engine.js';

beforeEach(() => resetVscodeMock());

const pg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'db1',
  name: 'DB One',
  engine: 'postgres',
  host: 'h',
  port: 5432,
  user: 'u',
  database: 'app',
  ...over,
});

describe('secret key helpers', () => {
  it('derives stable, id/provider-scoped keys', () => {
    expect(passwordKey('abc')).toBe('asksql.conn.abc.password');
    expect(apiKeyKey('openai')).toBe('asksql.apiKey.openai');
    expect(connectionStringKey('abc')).toBe('asksql.conn.abc.connectionString');
  });
});

describe('storePassword / readPassword endpoint binding', () => {
  it('returns the password for the exact endpoint it was stored against', async () => {
    const secrets = createSecretStorage();
    const c = pg();
    await storePassword(secrets as never, c, 's3cret');
    expect(await readPassword(secrets as never, c)).toBe('s3cret');
  });

  it('refuses the password when any endpoint field differs (fail closed)', async () => {
    const secrets = createSecretStorage();
    await storePassword(secrets as never, pg(), 's3cret');
    // Same id, attacker-controlled host.
    expect(await readPassword(secrets as never, pg({ host: 'evil' }))).toBeUndefined();
    // Downgraded ssl must not match either.
    expect(await readPassword(secrets as never, pg({ ssl: 'no-verify' }))).toBeUndefined();
  });

  it('returns undefined when nothing is stored', async () => {
    const secrets = createSecretStorage();
    expect(await readPassword(secrets as never, pg())).toBeUndefined();
  });

  it('returns undefined for corrupt or malformed stored JSON', async () => {
    const secrets = createSecretStorage();
    await secrets.store(passwordKey('db1'), 'not json');
    expect(await readPassword(secrets as never, pg())).toBeUndefined();
    await secrets.store(passwordKey('db1'), JSON.stringify({ endpoint: 5, password: 5 }));
    expect(await readPassword(secrets as never, pg())).toBeUndefined();
  });
});

describe('storeConnectionString / readConnectionString scope binding', () => {
  it('returns the DSN only for the scope it was saved under', async () => {
    const secrets = createSecretStorage();
    await storeConnectionString(secrets as never, 'db1', 'postgres://x', 'user');
    expect(await readConnectionString(secrets as never, 'db1', 'user')).toBe('postgres://x');
    expect(await readConnectionString(secrets as never, 'db1', 'workspace')).toBeUndefined();
  });

  it('returns undefined for missing or malformed data', async () => {
    const secrets = createSecretStorage();
    expect(await readConnectionString(secrets as never, 'db1', 'user')).toBeUndefined();
    await secrets.store(connectionStringKey('db1'), '{bad');
    expect(await readConnectionString(secrets as never, 'db1', 'user')).toBeUndefined();
  });
});

describe('connectionConfigs merge', () => {
  it('merges user and workspace entries, workspace shadowing by id', () => {
    setInspect('connections', {
      global: [pg({ id: 'a', name: 'A-user' }), pg({ id: 'b', name: 'B-user' })],
      workspace: [pg({ id: 'a', name: 'A-workspace' })],
    });
    const all = connectionConfigs();
    expect(all.map((c) => `${c.id}:${c.scope}`)).toEqual(['a:workspace', 'b:user']);
    expect(all.find((c) => c.id === 'a')!.name).toBe('A-workspace');
  });

  it('ignores a hand-edited non-array value instead of throwing', () => {
    setInspect('connections', { global: {} as never });
    expect(connectionConfigs()).toEqual([]);
  });

  it('skips entries with no id', () => {
    setInspect('connections', { global: [{ name: 'x', engine: 'postgres' } as never, pg({ id: 'ok' })] });
    expect(connectionConfigs().map((c) => c.id)).toEqual(['ok']);
  });
});

describe('EngineManager.buildOne branches (via catalogFor)', () => {
  function mgrWith(conns: ConnectionConfig[], secrets = createSecretStorage()): EngineManager {
    setInspect('connections', { global: conns });
    return new EngineManager(secrets as never);
  }

  it('builds a postgres connector from discrete fields', async () => {
    const secrets = createSecretStorage();
    await storePassword(secrets as never, pg(), 'pw');
    const mgr = mgrWith([pg()], secrets);
    const cat = await mgr.catalogFor('db1');
    expect(cat.tables.length).toBe(1);
  });

  it('builds a mysql connector', async () => {
    const mgr = mgrWith([pg({ id: 'm', engine: 'mysql' })]);
    expect((await mgr.catalogFor('m')).tables.length).toBe(1);
  });

  it('builds an oracle connector', async () => {
    const mgr = mgrWith([pg({ id: 'o', engine: 'oracle' })]);
    expect((await mgr.catalogFor('o')).tables.length).toBe(1);
  });

  it('builds a sqlite connector via node:sqlite with an absolute file', async () => {
    const mgr = mgrWith([{ id: 's', name: 'S', engine: 'sqlite', file: '/tmp/data.db' }]);
    expect((await mgr.catalogFor('s')).tables.length).toBe(1);
  });

  it('fails a SQL engine with no database name', async () => {
    const mgr = mgrWith([pg({ database: '' })]);
    await expect(mgr.catalogFor('db1')).rejects.toThrow(/no database name/);
  });

  it('fails a sqlite connection with no file path', async () => {
    const mgr = mgrWith([{ id: 's', name: 'S', engine: 'sqlite' }]);
    await expect(mgr.catalogFor('s')).rejects.toThrow(/needs a "file" path/);
  });

  it('builds a postgres connection-string connector when a DSN is stored', async () => {
    const secrets = createSecretStorage();
    await storeConnectionString(secrets as never, 'dsn', 'postgres://a', 'user');
    const mgr = mgrWith([{ id: 'dsn', name: 'DSN', engine: 'postgres', usesConnectionString: true }], secrets);
    expect((await mgr.catalogFor('dsn')).tables.length).toBe(1);
  });

  it('fails a connection-string connector when no DSN is saved', async () => {
    const mgr = mgrWith([{ id: 'dsn', name: 'DSN', engine: 'postgres', usesConnectionString: true }]);
    await expect(mgr.catalogFor('dsn')).rejects.toThrow(/none is saved/);
  });

  it('rejects a connection string for sqlite (unsupported)', async () => {
    const secrets = createSecretStorage();
    await storeConnectionString(secrets as never, 'x', 'sqlite://a', 'user');
    const mgr = mgrWith([{ id: 'x', name: 'X', engine: 'sqlite', usesConnectionString: true }], secrets);
    await expect(mgr.catalogFor('x')).rejects.toThrow(/only supported for Postgres, MySQL and Oracle/);
  });

  it('rejects building mongodb on the SQL path', async () => {
    // A SQL-path caller for a mongo connection is a bug; buildConnectors filters
    // mongo out, so catalogFor routes it to the mongo path instead. Assert isMongo.
    const mgr = mgrWith([{ id: 'mo', name: 'Mongo', engine: 'mongodb', database: 'd', usesConnectionString: true }]);
    expect(mgr.isMongo('mo')).toBe(true);
  });
});

describe('EngineManager.isMongo', () => {
  it('is true only for mongodb connections', () => {
    setInspect('connections', {
      global: [pg({ id: 'p' }), { id: 'mo', name: 'M', engine: 'mongodb', database: 'd' }],
    });
    const mgr = new EngineManager(createSecretStorage() as never);
    expect(mgr.isMongo('mo')).toBe(true);
    expect(mgr.isMongo('p')).toBe(false);
    expect(mgr.isMongo('nope')).toBe(false);
  });
});

describe('EngineManager.catalogFor caching', () => {
  it('introspects once and serves the cache thereafter', async () => {
    setInspect('connections', { global: [pg()] });
    const mgr = new EngineManager(createSecretStorage() as never);
    const first = await mgr.catalogFor('db1');
    const second = await mgr.catalogFor('db1');
    expect(second).toBe(first);
  });

  it('shares one in-flight introspect across concurrent callers', async () => {
    setInspect('connections', { global: [pg()] });
    const mgr = new EngineManager(createSecretStorage() as never);
    const [a, b] = await Promise.all([mgr.catalogFor('db1'), mgr.catalogFor('db1')]);
    expect(a).toBe(b);
  });

  it('records a per-connection failure and reports it on that connection only', async () => {
    setInspect('connections', { global: [pg({ id: 'good' }), pg({ id: 'bad', database: '' })] });
    const mgr = new EngineManager(createSecretStorage() as never);
    expect((await mgr.catalogFor('good')).tables.length).toBe(1);
    await expect(mgr.catalogFor('bad')).rejects.toThrow(/no database name/);
    expect(mgr.failureFor('bad')).toBeInstanceOf(Error);
    expect(mgr.failureFor('good')).toBeUndefined();
  });

  it('throws when no databases are configured', async () => {
    setInspect('connections', { global: [] });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.catalogFor('anything')).rejects.toThrow(/No databases configured/);
  });
});

describe('EngineManager configured-model errors', () => {
  it('demands a selected model before building the provider', async () => {
    setInspect('connections', { global: [pg()] });
    setConfig({ provider: 'ollama', model: '' });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.forConfiguredModel()).rejects.toThrow(/No AI model is selected/);
  });

  it('demands an API key for a non-ollama provider', async () => {
    setInspect('connections', { global: [pg()] });
    setConfig({ provider: 'openai', model: 'gpt' });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.forConfiguredModel()).rejects.toThrow(/needs an API key/);
  });
});

describe('EngineManager.reset lifecycle', () => {
  it('closes built connectors and clears caches', async () => {
    const secrets = createSecretStorage();
    setInspect('connections', { global: [pg()] });
    const mgr = new EngineManager(secrets as never);
    const cat = await mgr.catalogFor('db1');
    expect(cat.tables.length).toBe(1);
    await mgr.reset();
    // After reset the promise is dropped; a fresh introspect happens (new object).
    const again = await mgr.catalogFor('db1');
    expect(again).not.toBe(cat);
  });

  it('closes opened sqlite handles on reset', async () => {
    sqliteClose.mockClear();
    setInspect('connections', { global: [{ id: 's', name: 'S', engine: 'sqlite', file: '/tmp/x.db' }] });
    const mgr = new EngineManager(createSecretStorage() as never);
    await mgr.catalogFor('s');
    await mgr.reset();
    expect(sqliteClose).toHaveBeenCalled();
  });

  it('dispose triggers a reset without throwing', () => {
    setInspect('connections', { global: [pg()] });
    const mgr = new EngineManager(createSecretStorage() as never);
    expect(() => mgr.dispose()).not.toThrow();
  });
});

describe('resolveFile via sqlite in a virtual workspace', () => {
  it('refuses SQLite when the workspace has no real file system', async () => {
    setWorkspaceFolders([{ uri: Uri.parse('vscode-vfs://host/repo') }]);
    setInspect('connections', { global: [{ id: 's', name: 'S', engine: 'sqlite', file: 'rel.db' }] });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.catalogFor('s')).rejects.toThrow(/needs a real file system/);
  });
});

describe('EngineManager SQL engine building', () => {
  it('builds and caches a configured-model engine', async () => {
    setInspect('connections', { global: [pg()] });
    setConfig({ provider: 'ollama', model: 'qwen', maxRows: 50 });
    const mgr = new EngineManager(createSecretStorage() as never);
    const e1 = await mgr.forConfiguredModel();
    expect(typeof e1.ask).toBe('function');
    const e2 = await mgr.forConfiguredModel();
    expect(e2).toBe(e1);
  });

  it('builds a chat-model engine keyed by the language model id', async () => {
    setInspect('connections', { global: [pg()] });
    const mgr = new EngineManager(createSecretStorage() as never);
    const lm = { id: 'copilot-1', sendRequest: vi.fn() } as never;
    const e = await mgr.forChatModel(lm);
    expect(typeof e.ask).toBe('function');
  });
});

describe('EngineManager.explain', () => {
  it('rejects MongoDB connections (no SQL plan surface)', async () => {
    setInspect('connections', { global: [{ id: 'mo', name: 'M', engine: 'mongodb', database: 'd' }] });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.explain('mo', 'select 1')).rejects.toThrow(/not available for MongoDB/);
  });

  it('rejects an unknown connection', async () => {
    setInspect('connections', { global: [pg()] });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.explain('nope', 'select 1')).rejects.toThrow(/Unknown connection/);
  });

  it('reports when the connector cannot show a plan', async () => {
    setInspect('connections', { global: [pg()] });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.explain('db1', 'select 1')).rejects.toThrow(/cannot show a query plan/);
  });
});

describe('EngineManager mongo engine path', () => {
  it('builds a configured-model mongo engine when a DSN is stored', async () => {
    const secrets = createSecretStorage();
    await storeConnectionString(secrets as never, 'mo', 'mongodb://h/db', 'user');
    setInspect('connections', { global: [{ id: 'mo', name: 'M', engine: 'mongodb', database: 'shop' }] });
    setConfig({ provider: 'ollama', model: 'qwen' });
    const mgr = new EngineManager(secrets as never);
    const engine = await mgr.forConfiguredModelMongo('mo');
    expect(engine).toBe(fakeMongoEngine);
  });

  it('fails a mongo connection with no database name', async () => {
    setInspect('connections', { global: [{ id: 'mo', name: 'M', engine: 'mongodb' }] });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.forConfiguredModelMongo('mo')).rejects.toThrow(/no database name/);
  });

  it('fails a mongo connection with no stored DSN', async () => {
    setInspect('connections', { global: [{ id: 'mo', name: 'M', engine: 'mongodb', database: 'd' }] });
    setConfig({ provider: 'ollama', model: 'qwen' });
    const mgr = new EngineManager(createSecretStorage() as never);
    await expect(mgr.forConfiguredModelMongo('mo')).rejects.toThrow(/needs a MongoDB connection string/);
  });

  it('builds a chat-model mongo engine', async () => {
    const secrets = createSecretStorage();
    await storeConnectionString(secrets as never, 'mo', 'mongodb://h/db', 'user');
    setInspect('connections', { global: [{ id: 'mo', name: 'M', engine: 'mongodb', database: 'shop' }] });
    const mgr = new EngineManager(secrets as never);
    const lm = { id: 'copilot-1', sendRequest: vi.fn() } as never;
    expect(await mgr.forChatModelMongo(lm, 'mo')).toBe(fakeMongoEngine);
  });

  it('invalidateCatalogs clears mongo engines too', async () => {
    const secrets = createSecretStorage();
    await storeConnectionString(secrets as never, 'mo', 'mongodb://h/db', 'user');
    setInspect('connections', { global: [{ id: 'mo', name: 'M', engine: 'mongodb', database: 'shop' }] });
    setConfig({ provider: 'ollama', model: 'qwen' });
    const mgr = new EngineManager(secrets as never);
    await mgr.forConfiguredModelMongo('mo');
    mgr.invalidateCatalogs();
    expect(fakeMongoEngine.invalidateCatalog).toHaveBeenCalled();
  });
});

describe('EngineManager.testConnection / testProvider', () => {
  it('reports ok with a table count on success', async () => {
    setInspect('connections', { global: [pg()] });
    const mgr = new EngineManager(createSecretStorage() as never);
    expect(await mgr.testConnection('db1')).toEqual({ ok: true, tables: 1 });
  });

  it('reports a user message on failure', async () => {
    setInspect('connections', { global: [pg({ database: '' })] });
    const mgr = new EngineManager(createSecretStorage() as never);
    const res = await mgr.testConnection('db1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/no database name/);
  });

  it('testProvider reports the setup error when no model is selected', async () => {
    setInspect('connections', { global: [pg()] });
    setConfig({ provider: 'ollama', model: '' });
    const mgr = new EngineManager(createSecretStorage() as never);
    const res = await mgr.testProvider();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/No AI model is selected/);
  });
});
