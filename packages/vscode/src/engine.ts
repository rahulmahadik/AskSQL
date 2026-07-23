/**
 * Owns connectors, credentials, and engines.
 *
 * Two model sources: the chat model the user picked in VS Code (no API key),
 * or a configured provider (Ollama/OpenAI/...) for use outside chat.
 *
 * Engines are cached per model so the introspected schema stays warm; connectors
 * are built once and shared, so a chat turn never re-opens the database.
 *
 * Drivers are pure JS (`pg`, `mysql2`, built-in `node:sqlite`), so the extension
 * ships no native modules that would have to match VS Code's Electron ABI.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  createAskSql,
  callModel,
  guardSql,
  type AskSqlEngine,
  type Connector,
  type ModelLike,
  type ResultSet,
  type SchemaCatalog,
} from '@asksql/core';
import { createMongoAskSql, type MongoAskEngine, type MongoConnector } from '@asksql/core/mongo';
import { PostgresConnector } from '@asksql/postgres';
import { MysqlConnector } from '@asksql/mysql';
import { SqliteConnector } from '@asksql/sqlite';
import { OracleConnector } from '@asksql/oracle';
import { MongodbConnector } from '@asksql/mongodb';
import { lmCustomModel } from './model.js';
import { buildModel, type ProviderName } from './providers.js';
import { CONNECT_TIMEOUT_MS, PROVIDER_TEST_TIMEOUT_MS } from './constants.js';
import { log, detailOf } from './log.js';
import { UserFacingError, userMessage } from './errors.js';

export interface ConnectionConfig {
  readonly id: string;
  readonly name: string;
  readonly engine: 'postgres' | 'mysql' | 'sqlite' | 'oracle' | 'mongodb';
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly database?: string;
  readonly file?: string;
  /**
   * SSL/TLS mode: 'verify' encrypts and checks the server certificate;
   * 'no-verify' encrypts without the check. Omit for a plain connection.
   * Discrete-field connections only; a connection string carries its own SSL settings.
   */
  readonly ssl?: 'verify' | 'no-verify';
  /**
   * This connection is defined by a full connection string (DSN) rather than
   * discrete fields. The string carries credentials, so it lives in the OS
   * keychain (see connectionStringKey), never in settings - only this marker does.
   */
  readonly usesConnectionString?: boolean;
}

/**
 * One stable secret key per connection id. The endpoint is bound into the
 * stored value (see storePassword/readPassword), not the key, so editing a
 * connection never orphans its password and removal always finds the key.
 */
export const passwordKey = (id: string): string => `asksql.conn.${id}.password`;

/** API keys are stored per provider, so one provider's key is never sent to another's endpoint. */
export const apiKeyKey = (provider: string): string => `asksql.apiKey.${provider}`;

/**
 * The endpoint a password was saved against. Binds every field that decides
 * where the password goes and how it crosses the wire - `ssl` included, so a
 * cloned config with a downgraded `ssl` does not match.
 */
const endpointOf = (
  c: Pick<ConnectionConfig, 'engine' | 'host' | 'port' | 'user' | 'database' | 'file' | 'ssl'>,
): string =>
  `${c.engine}|${c.host ?? ''}:${c.port ?? ''}/${c.database ?? c.file ?? ''}|${c.user ?? ''}|${c.ssl ?? 'none'}`;

interface StoredPassword {
  readonly endpoint: string;
  readonly password: string;
}

/** Save a password together with the endpoint it belongs to. */
export async function storePassword(
  secrets: vscode.SecretStorage,
  c: ConnectionConfig,
  password: string,
): Promise<void> {
  const payload: StoredPassword = { endpoint: endpointOf(c), password };
  await secrets.store(passwordKey(c.id), JSON.stringify(payload));
}

/**
 * Read a password, only for the endpoint it was saved against.
 *
 * Security control: `asksql.connections` is window-scoped and ids are guessable,
 * so a shared repo could declare a connection with the victim's id but an
 * attacker's host and receive the real password. Anything that does not match
 * the stored endpoint yields no password - fail closed.
 */
export async function readPassword(secrets: vscode.SecretStorage, c: ConnectionConfig): Promise<string | undefined> {
  const raw = await secrets.get(passwordKey(c.id));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const stored = parsed as Partial<StoredPassword> | null;
  if (!stored || typeof stored.password !== 'string' || typeof stored.endpoint !== 'string') return undefined;
  if (stored.endpoint !== endpointOf(c)) {
    log.warn(`stored password for "${c.id}" was saved for a different endpoint; not using it`);
    return undefined;
  }
  return stored.password;
}

/**
 * A connection string is a full DSN with credentials, so the entire string is a
 * secret and lives in the keychain; settings holds only the `usesConnectionString`
 * marker. The DSN is bound to the scope it was saved under, so a workspace entry
 * cannot borrow a user-saved DSN by reusing its id.
 */
export const connectionStringKey = (id: string): string => `asksql.conn.${id}.connectionString`;

interface StoredDsn {
  readonly scope: ConnectionScope;
  readonly dsn: string;
}

export async function storeConnectionString(
  secrets: vscode.SecretStorage,
  id: string,
  dsn: string,
  scope: ConnectionScope,
): Promise<void> {
  const payload: StoredDsn = { scope, dsn };
  await secrets.store(connectionStringKey(id), JSON.stringify(payload));
}

export async function readConnectionString(
  secrets: vscode.SecretStorage,
  id: string,
  scope: ConnectionScope,
): Promise<string | undefined> {
  const raw = await secrets.get(connectionStringKey(id));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const stored = parsed as Partial<StoredDsn> | null;
  if (!stored || typeof stored.dsn !== 'string' || typeof stored.scope !== 'string') return undefined;
  if (stored.scope !== scope) {
    log.warn(`stored connection string for "${id}" was saved under a different scope; not using it`);
    return undefined;
  }
  return stored.dsn;
}

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('asksql');

/** Where a connection is defined. Shown to the user so the list is never a mystery. */
export type ConnectionScope = 'user' | 'workspace';

/**
 * Every configured connection, from both user and workspace settings.
 *
 * VS Code does not merge array settings - a workspace value replaces the user
 * value - so `.get('connections')` would hide user-level connections whenever a
 * workspace defines any. Workspace entries come first so a project can shadow a
 * user entry by id.
 */
export const connectionConfigs = (): (ConnectionConfig & { readonly scope: ConnectionScope })[] => {
  const info = cfg().inspect<ConnectionConfig[]>('connections');
  const out: (ConnectionConfig & { scope: ConnectionScope })[] = [];
  const seen = new Set<string>();
  const take = (list: ConnectionConfig[] | undefined, scope: ConnectionScope): void => {
    // inspect() returns the raw settings value; ignore a hand-edited non-array
    // (e.g. {}) rather than throwing on iteration.
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!c?.id || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ ...c, scope });
    }
  };
  take(info?.workspaceValue, 'workspace');
  take(info?.globalValue, 'user');
  return out;
};

function resolveFile(file: string): string {
  if (path.isAbsolute(file)) return file;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return file;
  // A virtual workspace (vscode-vfs://, github://) has no real path; .fsPath is
  // meaningless and node:sqlite fails with an opaque ENOENT.
  if (root.scheme !== 'file') {
    throw new UserFacingError(
      'SQLite needs a real file system, which this workspace does not have. Use a Postgres or MySQL connection here.',
    );
  }
  return path.join(root.fsPath, file);
}

/** A SQLite handle we opened and therefore must close ourselves. */
interface SqliteHandle {
  close?: () => void;
}

/** Open SQLite through Node's built-in driver - no native module, no ABI risk. */
async function openSqlite(file: string): Promise<SqliteHandle> {
  // resolveFile may throw its own UserFacingError (virtual workspace) - let it
  // propagate; only the driver import is the "no node:sqlite" case.
  const resolved = resolveFile(file);
  let mod: { DatabaseSync: new (p: string, o?: object) => SqliteHandle };
  try {
    mod = (await import('node:sqlite')) as { DatabaseSync: new (p: string, o?: object) => SqliteHandle };
  } catch (err) {
    throw new UserFacingError(
      `SQLite needs Node's built-in sqlite module, which this VS Code build does not provide (${
        err instanceof Error ? err.message : String(err)
      }). Use a Postgres or MySQL connection instead.`,
    );
  }
  try {
    return new mod.DatabaseSync(resolved, { readOnly: true });
  } catch (err) {
    throw new UserFacingError(
      `Could not open the SQLite file "${file}": ${err instanceof Error ? err.message : String(err)}. Check that the path exists and is readable.`,
    );
  }
}

/** Bound an operation that has no timeout of its own. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UserFacingError(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class EngineManager {
  /**
   * The in-flight build. Caching the promise (not the resolved array) keeps two
   * concurrent callers from each building a connector set and orphaning one.
   */
  private connectorsPromise: Promise<Connector[]> | undefined;
  private readonly engines = new Map<string, AskSqlEngine>();
  /** MongoDB is a separate, non-SQL engine path; its connectors and engines live apart from the SQL ones. */
  private mongoConnectorsPromise: Promise<Map<string, MongoConnector>> | undefined;
  private readonly mongoEngines = new Map<string, MongoAskEngine>();
  /** connectionId -> catalog. Introspection is expensive; the tree expands often. */
  private readonly catalogs = new Map<string, SchemaCatalog>();
  /** In-flight introspects, so concurrent tree expansions share one, not N. */
  private readonly catalogInflight = new Map<string, Promise<SchemaCatalog>>();
  /** Per-connection build failures, so one bad config does not kill every database. */
  private failures = new Map<string, Error>();
  /**
   * SQLite handles opened here must be closed here: SqliteConnector's close()
   * is a no-op for handles it did not open (we always pass `database`).
   */
  private sqliteHandles: SqliteHandle[] = [];
  /**
   * Bumped by reset(). A build suspended at an `await` when reset() lands must
   * not cache its now-stale result over the fresh state.
   */
  private generation = 0;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  private async buildOne(c: ConnectionConfig & { scope: ConnectionScope }): Promise<Connector> {
    const gen = this.generation;
    // Opt-in (off by default): connectors may sample distinct values from short
    // text columns. The one lever that sends column data, not just schema, to the model.
    const sampleColumnValues = cfg().get<boolean>('sampleColumnValues') ?? false;

    // Connection-string mode: the whole DSN (host, user, password, SSL) lives in
    // the keychain. Postgres takes it as connectionString, MySQL as uri.
    if (c.usesConnectionString) {
      const dsn = await readConnectionString(this.secrets, c.id, c.scope);
      if (!dsn) {
        throw new UserFacingError(
          `"${c.name}" is set to use a connection string, but none is saved on this machine. Run "AskSQL: Add Database Connection" again to re-enter it.`,
        );
      }
      if (c.engine === 'postgres') {
        return new PostgresConnector({
          id: c.id,
          name: c.name,
          connectionString: dsn,
          sampleColumnValues,
        }) as unknown as Connector;
      }
      if (c.engine === 'mysql') {
        // database is carried inside the uri; '' matches the discrete path's convention.
        return new MysqlConnector({
          id: c.id,
          name: c.name,
          uri: dsn,
          database: '',
          sampleColumnValues,
        }) as unknown as Connector;
      }
      if (c.engine === 'oracle') {
        return new OracleConnector({
          id: c.id,
          name: c.name,
          connectString: dsn,
          sampleColumnValues,
        }) as unknown as Connector;
      }
      throw new UserFacingError(
        `Connection strings are only supported for Postgres, MySQL and Oracle, not "${c.name}".`,
      );
    }

    const password = await readPassword(this.secrets, c);
    // 'verify' = strict TLS against the system CA store (managed cloud databases).
    // 'no-verify' = encrypt without checking the cert (self-signed / self-hosted).
    // pg takes ssl:true for verify; mysql2 needs an object either way.
    const pgSsl = c.ssl === 'verify' ? true : c.ssl === 'no-verify' ? { rejectUnauthorized: false } : undefined;
    const mySsl =
      c.ssl === 'verify'
        ? { rejectUnauthorized: true }
        : c.ssl === 'no-verify'
          ? { rejectUnauthorized: false }
          : undefined;
    // An empty database name connects and then introspects to zero tables; fail
    // with the actual reason instead.
    if ((c.engine === 'postgres' || c.engine === 'mysql' || c.engine === 'oracle') && !c.database?.trim()) {
      throw new UserFacingError(
        `"${c.name}" has no database name, so there are no tables to read. Run "AskSQL: Add Database Connection" again, or set the database in Settings.`,
      );
    }
    if (c.engine === 'postgres') {
      return new PostgresConnector({
        id: c.id,
        name: c.name,
        host: c.host,
        port: c.port,
        user: c.user,
        password,
        database: c.database,
        ssl: pgSsl,
        sampleColumnValues,
      }) as unknown as Connector;
    }
    if (c.engine === 'mysql') {
      return new MysqlConnector({
        id: c.id,
        name: c.name,
        host: c.host,
        port: c.port,
        user: c.user,
        password,
        database: c.database ?? '',
        ssl: mySsl,
        sampleColumnValues,
      }) as unknown as Connector;
    }
    if (c.engine === 'oracle') {
      // The Oracle driver runs in pure-JS Thin mode; `database` is the service name.
      return new OracleConnector({
        id: c.id,
        name: c.name,
        host: c.host,
        port: c.port,
        user: c.user,
        password,
        database: c.database,
        sampleColumnValues,
      }) as unknown as Connector;
    }
    if (c.engine === 'mongodb') {
      // MongoDB is not a SQL connector; it must be built via buildMongoOne, never here.
      throw new UserFacingError(`"${c.name}" is a MongoDB connection and cannot be used on the SQL path.`);
    }
    if (!c.file) throw new UserFacingError(`SQLite connection "${c.name}" needs a "file" path in settings.`);
    const handle = await openSqlite(c.file);
    // A reset() during the open would push this into the new handle array and leak the FD; close it and bail.
    if (gen !== this.generation) {
      handle.close?.();
      throw new UserFacingError(`"${c.name}" was reset during setup.`);
    }
    this.sqliteHandles.push(handle);
    return new SqliteConnector({
      id: c.id,
      name: c.name,
      database: handle as never,
      sampleColumnValues,
    }) as unknown as Connector;
  }

  /** True when a configured connection is MongoDB (routed to the separate non-SQL engine). */
  isMongo(connectionId: string): boolean {
    return connectionConfigs().find((c) => c.id === connectionId)?.engine === 'mongodb';
  }

  /** Build one MongoDB connector. Mongo connects by URI (creds inside), so it always uses a stored connection string. */
  private async buildMongoOne(c: ConnectionConfig & { scope: ConnectionScope }): Promise<MongoConnector> {
    const sampleColumnValues = cfg().get<boolean>('sampleColumnValues') ?? false;
    if (!c.database?.trim()) {
      throw new UserFacingError(
        `"${c.name}" has no database name, so there are no collections to read. Run "AskSQL: Add Database Connection" again, or set the database in Settings.`,
      );
    }
    const dsn = await readConnectionString(this.secrets, c.id, c.scope);
    if (!dsn) {
      throw new UserFacingError(
        `"${c.name}" needs a MongoDB connection string, but none is saved on this machine. Run "AskSQL: Add Database Connection" again to re-enter it.`,
      );
    }
    return new MongodbConnector({
      id: c.id,
      name: c.name,
      connectionString: dsn,
      database: c.database,
      sampleColumnValues,
    }) as unknown as MongoConnector;
  }

  /** Build every MongoDB connector, isolating failures onto their own connection (same policy as the SQL set). */
  private buildMongoConnectors(): Promise<Map<string, MongoConnector>> {
    if (!this.mongoConnectorsPromise) {
      const p = (async () => {
        const map = new Map<string, MongoConnector>();
        const conns = connectionConfigs().filter((c) => c.engine === 'mongodb');
        for (const c of conns) {
          try {
            map.set(c.id, await this.buildMongoOne(c));
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            log.error(`MongoDB connection "${c.id}" could not be prepared`, e);
            this.failures.set(c.id, e);
          }
        }
        return map;
      })().catch((err: unknown) => {
        if (this.mongoConnectorsPromise === p) this.mongoConnectorsPromise = undefined;
        throw err;
      });
      this.mongoConnectorsPromise = p;
    }
    return this.mongoConnectorsPromise;
  }

  private async mongoConnectorFor(connectionId: string): Promise<MongoConnector> {
    const map = await this.buildMongoConnectors();
    const conn = map.get(connectionId);
    if (!conn) {
      const failed = this.failures.get(connectionId);
      if (failed) throw failed;
      throw new Error(`Unknown MongoDB connection "${connectionId}".`);
    }
    return conn;
  }

  /** A MongoDB answering engine bound to one connection + model. Cached like the SQL engines. */
  private async mongoEngineFor(
    key: string,
    connectionId: string,
    model: () => Promise<ModelLike> | ModelLike,
  ): Promise<MongoAskEngine> {
    const cacheKey = `${key}:${connectionId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = this.mongoEngines.get(cacheKey);
      if (existing) return existing;
      const gen = this.generation;
      const connector = await this.mongoConnectorFor(connectionId);
      const resolved = await model();
      if (gen !== this.generation) continue;
      const engine = createMongoAskSql({
        connector,
        model: resolved,
        policy: { maxRows: cfg().get<number>('maxRows') ?? 1000 },
      });
      this.mongoEngines.set(cacheKey, engine);
      return engine;
    }
    throw new UserFacingError('Settings changed while the query was being prepared. Ask again.');
  }

  /** MongoDB engine for the chat-picked model. */
  forChatModelMongo(lm: vscode.LanguageModelChat, connectionId: string): Promise<MongoAskEngine> {
    return this.mongoEngineFor(`lm:${lm.id}`, connectionId, () => lmCustomModel(lm));
  }

  /** MongoDB engine for the configured provider. */
  forConfiguredModelMongo(connectionId: string): Promise<MongoAskEngine> {
    return this.mongoEngineFor('cfg', connectionId, () => this.configuredModel());
  }

  /**
   * Build every connector, isolating failures: a single bad entry is recorded
   * per connection and reported on that connection's node, not on the others.
   */
  private async buildConnectors(): Promise<Connector[]> {
    const all = connectionConfigs();
    if (all.length === 0) {
      throw new UserFacingError('No databases configured. Run "AskSQL: Add Database Connection".');
    }
    // MongoDB connections are built on their own (non-SQL) path; skip them here.
    const conns = all.filter((c) => c.engine !== 'mongodb');
    const built = await Promise.all(
      conns.map(async (c): Promise<Connector | undefined> => {
        try {
          return await this.buildOne(c);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          log.error(`connection "${c.id}" could not be prepared`, e);
          this.failures.set(c.id, e);
          return undefined;
        }
      }),
    );
    const ok = built.filter((c): c is Connector => c !== undefined);
    // Only fail when there are SQL connections and none opened. A workspace of
    // MongoDB-only connections legitimately yields zero SQL connectors.
    if (conns.length > 0 && ok.length === 0) {
      throw new UserFacingError(
        conns.length === 1
          ? `"${conns[0]!.name}" could not be opened. ${this.failures.get(conns[0]!.id)?.message ?? ''}`.trim()
          : 'None of the configured databases could be opened. See the AskSQL output channel for details.',
      );
    }
    return ok;
  }

  private sharedConnectors(): Promise<Connector[]> {
    if (!this.connectorsPromise) {
      // Cache the promise, but drop it on failure so the next attempt retries
      // rather than replaying a rejection forever.
      const p: Promise<Connector[]> = this.buildConnectors().catch((err: unknown) => {
        // Only clear our own promise - a reset() may have started a newer build.
        if (this.connectorsPromise === p) this.connectorsPromise = undefined;
        throw err;
      });
      this.connectorsPromise = p;
      return p;
    }
    return this.connectorsPromise;
  }

  /** The provider configured in settings - the path when chat models are not in play. */
  private async configuredModel(): Promise<ModelLike> {
    const provider = (cfg().get<string>('provider') ?? 'ollama') as ProviderName;
    // No default model id: guessing one the user has not pulled fails as a
    // confusing provider error.
    const model = cfg().get<string>('model')?.trim();
    if (!model) {
      throw new UserFacingError('No AI model is selected yet.', {
        action: 'asksql.selectProvider',
        actionLabel: 'Set up provider',
      });
    }
    const baseURL = cfg().get<string>('baseURL') || undefined;
    const apiKey = (await this.secrets.get(apiKeyKey(provider))) ?? undefined;
    if (provider !== 'ollama' && !apiKey) {
      throw new UserFacingError(`The "${provider}" provider needs an API key.`, {
        action: 'asksql.setApiKey',
        actionLabel: 'Set API key',
      });
    }
    // Built from statically-imported factories (see providers.ts) so the bundled
    // extension works without node_modules.
    return buildModel({ provider, model, apiKey, baseURL });
  }

  /**
   * Introspect a connection without a model. Reading the schema is a pure
   * database operation and must not depend on an AI provider being configured.
   */
  async catalogFor(connectionId: string): Promise<SchemaCatalog> {
    const cached = this.catalogs.get(connectionId);
    if (cached) return cached;
    // Share one in-flight introspect across concurrent callers.
    const running = this.catalogInflight.get(connectionId);
    if (running) return running;
    const p = this.introspectFresh(connectionId).finally(() => {
      this.catalogInflight.delete(connectionId);
    });
    this.catalogInflight.set(connectionId, p);
    return p;
  }

  private async introspectFresh(connectionId: string): Promise<SchemaCatalog> {
    const gen = this.generation;
    // Both Connector and MongoConnector expose connect() + introspect(); pick the
    // right source, then read the schema through the shared shape.
    let conn: { connect(): Promise<void>; introspect(): Promise<SchemaCatalog> } | undefined;
    if (this.isMongo(connectionId)) {
      conn = await this.mongoConnectorFor(connectionId);
    } else {
      conn = (await this.sharedConnectors()).find((c) => c.id === connectionId);
    }
    if (!conn) {
      // Distinguish "misconfigured" from "not a connection at all" - the first
      // is actionable, the second is a bug in our own id handling.
      const failed = this.failures.get(connectionId);
      if (failed) throw failed;
      throw new Error(`Unknown connection "${connectionId}".`);
    }
    const name = connectionConfigs().find((c) => c.id === connectionId)?.name ?? connectionId;
    await withTimeout(
      conn.connect(),
      CONNECT_TIMEOUT_MS,
      `Could not reach "${name}" within ${CONNECT_TIMEOUT_MS / 1000} seconds. Check the host, port, and that the database is running.`,
    );
    const cat = await withTimeout(
      conn.introspect(),
      CONNECT_TIMEOUT_MS,
      `Reading the schema of "${name}" took too long.`,
    );
    // A reset() while we were awaiting means this catalog belongs to connectors
    // that are now closed - return it to this caller but never cache it.
    if (gen === this.generation) this.catalogs.set(connectionId, cat);
    return cat;
  }

  private async engineFor(key: string, model: () => Promise<ModelLike> | ModelLike): Promise<AskSqlEngine> {
    // Bounded retry: a reset() landing mid-build invalidates this engine, so
    // rebuild against the fresh state rather than caching one bound to closed connectors.
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = this.engines.get(key);
      if (existing) return existing;
      const gen = this.generation;
      const connectors = await this.sharedConnectors();
      const resolved = await model();
      if (gen !== this.generation) continue;
      const engine = createAskSql({
        connectors,
        model: resolved,
        policy: { maxRows: cfg().get<number>('maxRows') ?? 1000 },
      });
      this.engines.set(key, engine);
      return engine;
    }
    throw new UserFacingError('Settings changed while the query was being prepared. Ask again.');
  }

  /**
   * The recorded build failure for a connection, if any. A connection that failed
   * to build (bad file path, missing database name) is absent from the engine, so
   * a query against it otherwise surfaces as a generic "unknown connection".
   */
  failureFor(connectionId: string): Error | undefined {
    return this.failures.get(connectionId);
  }

  /** Engine backed by the model the user picked in the chat dropdown. */
  forChatModel(lm: vscode.LanguageModelChat): Promise<AskSqlEngine> {
    return this.engineFor(`lm:${lm.id}`, () => lmCustomModel(lm));
  }

  /** Engine backed by the configured provider (settings + SecretStorage). */
  forConfiguredModel(): Promise<AskSqlEngine> {
    return this.engineFor('cfg', () => this.configuredModel());
  }

  /**
   * The query plan for a statement, from the database itself - a plan is a
   * database answer, not something a model can know.
   */
  async explain(connectionId: string, sql: string): Promise<ResultSet> {
    if (this.isMongo(connectionId)) {
      // A MongoDB aggregation has no SQL EXPLAIN plan surface here.
      throw new UserFacingError('Query plans are not available for MongoDB connections.');
    }
    const conn = (await this.sharedConnectors()).find((c) => c.id === connectionId);
    if (!conn) throw new UserFacingError(`Unknown connection "${connectionId}".`);
    if (!conn.explain) {
      throw new UserFacingError('This database cannot show a query plan.');
    }
    // The SQL arrives over the webview channel, so it is untrusted. Invariant:
    // every string reaching a database passes the guard first.
    const maxRows = cfg().get<number>('maxRows') ?? 1000;
    const verdict = guardSql({ sql, dialect: conn.dialect, policy: { mode: 'read-only', maxRows } });
    if (!verdict.allowed) {
      throw new UserFacingError(`That query cannot be explained: ${verdict.reason ?? 'it is not a read-only query'}.`);
    }
    await withTimeout(conn.connect(), CONNECT_TIMEOUT_MS, 'Could not reach the database to explain the plan.');
    return withTimeout(conn.explain(verdict.sql, { maxRows }), CONNECT_TIMEOUT_MS, 'The query plan took too long.');
  }

  /**
   * Drop the cached schema without tearing down connections. Engines cache
   * their own catalog internally, so they are dropped too and rebuild lazily.
   */
  invalidateCatalogs(): void {
    this.catalogs.clear();
    this.engines.clear();
    for (const e of this.mongoEngines.values()) e.invalidateCatalog();
    this.mongoEngines.clear();
  }

  /**
   * Connect to one connection and read its schema, on the real path (same
   * connector, same timeout), so a passing test means chat will work.
   */
  async testConnection(connectionId: string): Promise<{ ok: true; tables: number } | { ok: false; message: string }> {
    try {
      // Force a fresh read so the test reflects reality, not a warm cache.
      this.catalogs.delete(connectionId);
      const cat = await this.catalogFor(connectionId);
      return { ok: true, tables: cat.tables.length };
    } catch (err) {
      log.error(`connection test failed for "${connectionId}"`, err);
      return { ok: false, message: userMessage(err) };
    }
  }

  /**
   * Send the configured provider a trivial prompt. Covers the bring-your-own-LLM
   * path; VS Code owns the chat-model path and reports its own errors.
   */
  async testProvider(): Promise<{ ok: true; reply: string } | { ok: false; message: string }> {
    try {
      const model = await this.configuredModel();
      const res = await callModel({
        model,
        system: 'You are a terse assistant. Reply with exactly one word.',
        prompt: 'Reply with the single word: ready',
        signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
      });
      return { ok: true, reply: res.text.trim().slice(0, 40) || '(empty reply)' };
    } catch (err) {
      log.error('provider test failed', err);
      return { ok: false, message: userMessage(err) };
    }
  }

  /**
   * Settings or secrets changed: drop everything and close the connectors
   * directly, even when no engine was ever created.
   */
  async reset(): Promise<void> {
    this.generation++;
    const pending = this.connectorsPromise;
    const mongoPending = this.mongoConnectorsPromise;
    const handles = this.sqliteHandles;
    this.engines.clear();
    this.mongoEngines.clear();
    this.catalogs.clear();
    this.catalogInflight.clear();
    this.failures = new Map();
    this.connectorsPromise = undefined;
    this.mongoConnectorsPromise = undefined;
    this.sqliteHandles = [];

    if (pending) {
      try {
        const connectors = await pending;
        const closed = await Promise.allSettled(connectors.map((c) => c.close()));
        for (const r of closed) {
          if (r.status === 'rejected') log.warn('a database connection did not close cleanly', r.reason);
        }
      } catch (err) {
        // The build itself failed, so there is nothing to close. Already logged.
        log.info('reset: no connectors to close', detailOf(err));
      }
    }
    if (mongoPending) {
      try {
        const map = await mongoPending;
        const closed = await Promise.allSettled([...map.values()].map((c) => c.close()));
        for (const r of closed) {
          if (r.status === 'rejected') log.warn('a MongoDB connection did not close cleanly', r.reason);
        }
      } catch (err) {
        log.info('reset: no MongoDB connectors to close', detailOf(err));
      }
    }
    // We opened these, so we close them. The connector deliberately will not.
    for (const h of handles) {
      try {
        h.close?.();
      } catch (err) {
        log.warn('a SQLite file did not close cleanly', detailOf(err));
      }
    }
  }

  dispose(): void {
    void this.reset();
  }
}
