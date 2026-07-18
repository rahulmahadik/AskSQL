/**
 * Owns connectors, credentials, and engines.
 *
 * Two model sources:
 *  - the chat model the user picked in VS Code (no API key - preferred), and
 *  - a configured provider (Ollama/OpenAI/...) for use outside chat, or when the
 *    user wants a fully local model.
 *
 * Engines are cached per model so the introspected schema stays warm; connectors
 * are built once and shared, so a chat turn never re-opens the database.
 *
 * Driver choice is deliberate: `pg` and `mysql2` are pure JS and `node:sqlite`
 * is built in, so the extension ships ZERO native modules. Native modules must
 * match VS Code's Electron ABI, which is a well-known maintenance trap.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { createAskSql, callModel, guardSql, type AskSqlEngine, type Connector, type ModelLike, type ResultSet, type SchemaCatalog } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';
import { MysqlConnector } from '@asksql/mysql';
import { SqliteConnector } from '@asksql/sqlite';
import { lmCustomModel } from './model.js';
import { buildModel, type ProviderName } from './providers.js';
import { CONNECT_TIMEOUT_MS, PROVIDER_TEST_TIMEOUT_MS } from './constants.js';
import { log, detailOf } from './log.js';
import { UserFacingError, userMessage } from './errors.js';

export interface ConnectionConfig {
  readonly id: string;
  readonly name: string;
  readonly engine: 'postgres' | 'mysql' | 'sqlite';
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly database?: string;
  readonly file?: string;
  /**
   * SSL/TLS mode. 'verify' encrypts and checks the server certificate (managed
   * cloud databases); 'no-verify' encrypts but skips the check (self-signed /
   * self-hosted). Omit for a plain connection. Discrete-field connections only;
   * a connection string carries its own SSL settings.
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
 * One stable secret key per connection id.
 *
 * The endpoint is bound into the VALUE (see storePassword/readPassword), never
 * into the key. Putting it in the key also worked as a security control, but it
 * leaked secrets: the key changed whenever the host, port, or database changed,
 * so editing a connection orphaned its password in the OS keychain forever, and
 * "Remove connection" could only delete the key it could still compute. A stable
 * key means deletion always finds it and nothing is ever left behind.
 */
export const passwordKey = (id: string): string => `asksql.conn.${id}.password`;

/** API keys are stored per provider, so one provider's key is never sent to another's endpoint. */
export const apiKeyKey = (provider: string): string => `asksql.apiKey.${provider}`;

/**
 * The endpoint a password was saved against.
 *
 * This binds every field that decides WHERE the password goes and HOW it crosses
 * the wire - `ssl` included. Binding host/port/database alone let a workspace
 * clone a user's connection with the same endpoint but `ssl: 'no-verify'`: the
 * binding still matched, the keychain handed the real password over, and it went
 * out over unverified TLS for an on-path attacker to take.
 */
const endpointOf = (c: Pick<ConnectionConfig, 'engine' | 'host' | 'port' | 'user' | 'database' | 'file' | 'ssl'>): string =>
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
 * Read a password, but ONLY for the endpoint it was saved against.
 *
 * This is the security control. `asksql.connections` is window-scoped, so a
 * workspace `.vscode/settings.json` overrides the user's list, and ids are
 * guessable - the wizard derives them from the display name ("PostgreSQL" ->
 * `postgresql`). Without this check, a shared repo could declare a connection
 * carrying the victim's id but the ATTACKER's host, and the extension would
 * look the victim's real password out of the keychain and send it there.
 *
 * Anything that does not match, or is not in the expected shape, yields no
 * password: the connection then fails and the user is asked for one. Fail
 * closed, never guess.
 */
export async function readPassword(
  secrets: vscode.SecretStorage,
  c: ConnectionConfig,
): Promise<string | undefined> {
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
 * A connection string is a full DSN with credentials baked in, so the ENTIRE
 * string is a secret and lives in the keychain; settings holds only the
 * `usesConnectionString` marker. The DSN has no endpoint in settings to bind
 * against (readPassword's control), so bind it to the SCOPE it was saved under:
 * a workspace entry cannot borrow a user-saved DSN by reusing its id.
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
 * Every configured connection, from BOTH user and workspace settings.
 *
 * `.get('connections')` cannot be used here. VS Code does not merge array
 * settings - a workspace value REPLACES the user value outright. So the moment a
 * project had its own `.vscode/settings.json` with `asksql.connections`, every
 * connection the user had saved at user level vanished from the list, with no
 * error and nothing in the UI to explain it. For a list of databases that is
 * simply wrong: the user expects to see both, exactly like a list of servers.
 *
 * Workspace entries come first so a project can shadow a user entry by id.
 */
export const connectionConfigs = (): (ConnectionConfig & { readonly scope: ConnectionScope })[] => {
  const info = cfg().inspect<ConnectionConfig[]>('connections');
  const out: (ConnectionConfig & { scope: ConnectionScope })[] = [];
  const seen = new Set<string>();
  const take = (list: ConnectionConfig[] | undefined, scope: ConnectionScope): void => {
    // inspect() returns the RAW settings value; a hand-edited non-array (e.g. {})
    // must be ignored, not iterated - iterating it throws and would lock the panel.
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
  // In a virtual workspace (vscode-vfs://, github://) there is no real path, so
  // .fsPath yields something meaningless and node:sqlite fails with an opaque
  // ENOENT. The manifest already says SQLite needs a real file system - say so.
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
   * The in-flight build, not the resolved array.
   *
   * Caching the promise is what makes this safe: caching the array leaves a
   * check-then-assign straddling an `await`, so two concurrent callers (two tree
   * nodes expanding at once) each build a full connector set and one set is
   * orphaned - live pools and open SQLite handles with nothing referencing them.
   */
  private connectorsPromise: Promise<Connector[]> | undefined;
  private readonly engines = new Map<string, AskSqlEngine>();
  /** connectionId -> catalog. Introspection is expensive; the tree expands often. */
  private readonly catalogs = new Map<string, SchemaCatalog>();
  /** In-flight introspects, so concurrent tree expansions share one, not N. */
  private readonly catalogInflight = new Map<string, Promise<SchemaCatalog>>();
  /** Per-connection build failures, so one bad config does not kill every database. */
  private failures = new Map<string, Error>();
  /**
   * SQLite handles are opened HERE, so they must be closed here. SqliteConnector
   * only closes handles it opened itself (it checks `file && !database`, and we
   * always pass `database`), so its close() is a no-op for this path by design.
   */
  private sqliteHandles: SqliteHandle[] = [];
  /**
   * Bumped by reset(). A build suspended at an `await` when reset() lands must
   * not cache its now-stale result over the fresh state.
   */
  private generation = 0;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  private async buildOne(c: ConnectionConfig & { scope: ConnectionScope }): Promise<Connector> {
    // Opt-in (off by default): let connectors sample distinct values from short
    // text columns so the model sees real status codes. This is the one lever
    // that sends column data, not just schema, to the model.
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
        return new PostgresConnector({ id: c.id, name: c.name, connectionString: dsn, sampleColumnValues }) as unknown as Connector;
      }
      if (c.engine === 'mysql') {
        // database is carried inside the uri; '' matches the discrete path's convention.
        return new MysqlConnector({ id: c.id, name: c.name, uri: dsn, database: '', sampleColumnValues }) as unknown as Connector;
      }
      throw new UserFacingError(`Connection strings are only supported for Postgres and MySQL, not "${c.name}".`);
    }

    const password = await readPassword(this.secrets, c);
    // 'verify' = strict TLS against the system CA store (managed cloud databases).
    // 'no-verify' = encrypt without checking the cert (self-signed / self-hosted).
    // pg takes ssl:true for verify; mysql2 needs an object either way.
    const pgSsl = c.ssl === 'verify' ? true : c.ssl === 'no-verify' ? { rejectUnauthorized: false } : undefined;
    const mySsl = c.ssl === 'verify' ? { rejectUnauthorized: true } : c.ssl === 'no-verify' ? { rejectUnauthorized: false } : undefined;
    // An empty database name connects FINE and then introspects to zero tables,
    // which reads as "AskSQL cannot see my data" rather than "you left this
    // blank". Fail with the actual reason instead.
    if ((c.engine === 'postgres' || c.engine === 'mysql') && !c.database?.trim()) {
      throw new UserFacingError(
        `"${c.name}" has no database name, so there are no tables to read. Run "AskSQL: Add Database Connection" again, or set the database in Settings.`,
      );
    }
    if (c.engine === 'postgres') {
      return new PostgresConnector({
        id: c.id, name: c.name, host: c.host, port: c.port, user: c.user, password, database: c.database, ssl: pgSsl, sampleColumnValues,
      }) as unknown as Connector;
    }
    if (c.engine === 'mysql') {
      return new MysqlConnector({
        id: c.id, name: c.name, host: c.host, port: c.port, user: c.user, password, database: c.database ?? '', ssl: mySsl, sampleColumnValues,
      }) as unknown as Connector;
    }
    if (!c.file) throw new UserFacingError(`SQLite connection "${c.name}" needs a "file" path in settings.`);
    const handle = await openSqlite(c.file);
    this.sqliteHandles.push(handle);
    return new SqliteConnector({ id: c.id, name: c.name, database: handle as never, sampleColumnValues }) as unknown as Connector;
  }

  /**
   * Build every connector, isolating failures.
   *
   * A single bad entry must not take out the others: with Promise.all, one
   * missing SQLite file made every database unusable AND orphaned the handles
   * that had already opened. Failures are recorded per connection and reported
   * on that connection's node instead.
   */
  private async buildConnectors(): Promise<Connector[]> {
    const conns = connectionConfigs();
    if (conns.length === 0) {
      throw new UserFacingError('No databases configured. Run "AskSQL: Add Database Connection".');
    }
    const failures = new Map<string, Error>();
    const built = await Promise.all(
      conns.map(async (c): Promise<Connector | undefined> => {
        try {
          return await this.buildOne(c);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          log.error(`connection "${c.id}" could not be prepared`, e);
          failures.set(c.id, e);
          return undefined;
        }
      }),
    );
    this.failures = failures;
    const ok = built.filter((c): c is Connector => c !== undefined);
    if (ok.length === 0) {
      throw new UserFacingError(
        conns.length === 1
          ? `"${conns[0]!.name}" could not be opened. ${failures.get(conns[0]!.id)?.message ?? ''}`.trim()
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
    // No default model id on purpose: guessing one the user has not pulled fails
    // as a confusing provider error. Say what to do instead.
    const model = cfg().get<string>('model')?.trim();
    if (!model) {
      throw new UserFacingError('No AI model is selected. Run "AskSQL: Select AI Provider" to set one up.');
    }
    const baseURL = cfg().get<string>('baseURL') || undefined;
    const apiKey = (await this.secrets.get(apiKeyKey(provider))) ?? undefined;
    if (provider !== 'ollama' && !apiKey) {
      throw new UserFacingError(`The "${provider}" provider needs an API key. Run "AskSQL: Set AI Provider API Key".`);
    }
    // Built from statically-imported factories (see providers.ts) so the bundled
    // extension works without node_modules.
    return buildModel({ provider, model, apiKey, baseURL });
  }

  /**
   * Introspect a connection WITHOUT a model.
   *
   * Reading the schema is a pure database operation, so it must not depend on an
   * AI provider being configured - otherwise merely expanding the tree fails for
   * anyone who has not set up a model yet.
   */
  async catalogFor(connectionId: string): Promise<SchemaCatalog> {
    const cached = this.catalogs.get(connectionId);
    if (cached) return cached;
    // Share one introspect across concurrent callers (caching the value, not the
    // promise, let two tree nodes each open a connection and introspect in full).
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
    const conns = await this.sharedConnectors();
    const conn = conns.find((c) => c.id === connectionId);
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
    // Bounded retry: a reset() landing mid-build invalidates what we just made,
    // so rebuild against the fresh state rather than caching a stale engine
    // bound to closed connectors (which would fail for the rest of the session).
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
   * The query plan for a statement, from the database itself.
   *
   * Every connector implements explain(), so a plan is a real database answer -
   * not something to ask a model for. Asking "explain the query plan" in English
   * made the model return its IMPOSSIBLE sentinel, because a plan is not
   * something it can know.
   */
  async explain(connectionId: string, sql: string): Promise<ResultSet> {
    const conn = (await this.sharedConnectors()).find((c) => c.id === connectionId);
    if (!conn) throw new UserFacingError(`Unknown connection "${connectionId}".`);
    if (!conn.explain) {
      throw new UserFacingError('This database cannot show a query plan.');
    }
    // The SQL arrives over the webview channel, so it is untrusted like any other
    // input: guard it here too. This is the engine's invariant - every string
    // reaching a database passes the guard first - and this was the one path
    // that skipped it, leaning on the connector's read-only session instead.
    const maxRows = cfg().get<number>('maxRows') ?? 1000;
    const verdict = guardSql({ sql, dialect: conn.dialect, policy: { mode: 'read-only', maxRows } });
    if (!verdict.allowed) {
      throw new UserFacingError(`That query cannot be explained: ${verdict.reason ?? 'it is not a read-only query'}.`);
    }
    await withTimeout(conn.connect(), CONNECT_TIMEOUT_MS, 'Could not reach the database to explain the plan.');
    return withTimeout(
      conn.explain(verdict.sql, { maxRows }),
      CONNECT_TIMEOUT_MS,
      'The query plan took too long.',
    );
  }

  /**
   * Drop the cached schema without tearing down connections.
   *
   * The engines cache their own catalog internally (5 min TTL), so clearing only
   * this map left "Refresh Schema" refreshing the tree while chat kept answering
   * - and validating - against the stale schema, telling users a table they had
   * just created did not exist. Drop the engines too; they rebuild lazily.
   */
  invalidateCatalogs(): void {
    this.catalogs.clear();
    this.engines.clear();
  }

  /**
   * Connect to one connection and read its schema, reporting what happened.
   *
   * Built on the real path (same connector, same timeout) rather than a
   * lookalike, so a passing test genuinely means chat will work.
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
   * Send the configured provider a trivial prompt and see if it answers.
   *
   * The chat-model path needs no test: VS Code owns that model and reports its
   * own errors. This is for the bring-your-own-LLM path, where a wrong base URL,
   * a missing key, or an unpulled model otherwise only shows up mid-question.
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
   * Settings or secrets changed: drop everything so nothing stale survives.
   *
   * Closes the CONNECTORS directly rather than going through an engine. The old
   * code closed `engines[0]`, which silently did nothing whenever no engine had
   * been created - the common case of "used the tree, never opened chat" - and
   * leaked a live pg pool on every settings change.
   */
  async reset(): Promise<void> {
    this.generation++;
    const pending = this.connectorsPromise;
    const handles = this.sqliteHandles;
    this.engines.clear();
    this.catalogs.clear();
    this.catalogInflight.clear();
    this.failures = new Map();
    this.connectorsPromise = undefined;
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
