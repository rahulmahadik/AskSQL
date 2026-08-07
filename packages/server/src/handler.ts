/**
 * Framework-agnostic AskSQL server core: one `handle(req)` maps the sidecar's HTTP contract
 * onto the engine, enforcing for every adapter that auth runs first, that each connectionId is
 * in the caller's scope, that the guard runs server-side on execute, and that errors serialize
 * through AskSqlError.toJSON (code + userMessage, never credentials/detail/stack).
 */

import {
  AskSqlError,
  createAskSql,
  MemoryHistoryStore,
  type AskResult,
  type Connector,
  type EngineEvent,
} from '@asksql/core';
import { createMongoAskSql, type MongoAskEngine, type MongoConnector } from '@asksql/core/mongo';
import type { AskSqlServerConfig, AuthContext, ChatStreamEvent, ServerRequest } from './types.js';
import {
  assertSpecAllowed,
  createConnector,
  createMongoConnector,
  type ConnectionSpec,
  type DynamicConnectionOptions,
} from './dynamicConnections.js';

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface StreamResponse {
  readonly status: number;
  readonly stream: AsyncIterable<ChatStreamEvent>;
}

export type HandlerResponse = JsonResponse | StreamResponse;

export function isStream(r: HandlerResponse): r is StreamResponse {
  return 'stream' in r;
}

const DEFAULT_MAX_BODY = 64 * 1024;
/** Prior turns accepted from a client, and the cap on each field. */
const CONTEXT_TURNS = 6;
const MAX_CONTEXT_FIELD = 10_000;

/** Mongo answers with an aggregation pipeline, so the SQL-only capabilities do not apply. */
const MONGO_CAPABILITIES = {
  supportsCancel: false,
  // The wire /explain and the Plan button speak SQL (`EXPLAIN <stmt>` via /execute); keep this off until a mongo-shaped wire path exists.
  supportsExplain: false,
  supportsSchemas: false,
  readOnlySession: false,
  supportsMatViews: false,
  supportsTriggers: false,
  supportsRoutines: false,
} as const;

/** Wildcard auth scope: dynamic connections get server-generated ids that no static allowlist could name. */
export const ANY_CONNECTION = '*';

function canAccess(auth: AuthContext, connectionId: string): boolean {
  return auth.allowedConnectionIds.includes(ANY_CONNECTION) || auth.allowedConnectionIds.includes(connectionId);
}

/**
 * Cross-site request rejection, applied to every adapter rather than to one of them. Requiring
 * application/json forces a CORS preflight that a "simple request" would skip, and a non-loopback
 * Host on a loopback bind is a DNS-rebinding attempt.
 */
function crossSiteRejection(req: ServerRequest, requireLoopbackHost: boolean): HandlerResponse | null {
  const header = (name: string): string => {
    const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
    return typeof raw === 'string' ? raw : '';
  };
  // The host check covers EVERY method: a rebound GET reads the schema and history just as well.
  if (requireLoopbackHost) {
    // An absent Host is not a pass: HTTP/1.1 requires one, and omitting it would skip the check.
    const host = hostnameOf(header('host'));
    if (!LOOPBACK_HOSTS.has(host)) {
      return json(403, {
        error: {
          code: 'SERVER_AUTHZ',
          userMessage: 'This server only accepts requests addressed to localhost.',
          retryable: false,
        },
      });
    }
  }
  // Requiring application/json forces a CORS preflight that a "simple request" would skip.
  // Anything that is not a read gets it, so a method added later inherits the gate.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const contentType = header('content-type').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return json(415, {
      error: { code: 'INVALID_INPUT', userMessage: 'Send this request as application/json.', retryable: false },
    });
  }
  return null;
}

/** Hostname from a Host header, handling `[::1]:3000` and a bare `::1`. */
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  // A bare IPv6 address has several colons; only a host:port pair is split.
  if ((value.match(/:/g) ?? []).length > 1) return value;
  return value.split(':')[0]!;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export class AskSqlServer {
  private readonly history = new MemoryHistoryStore(2000);
  private engine;
  private connectors: Connector[];
  private byId: Map<string, Connector>;
  /** MongoDB is a separate, non-SQL engine path; its connectors and engines live apart from the SQL ones. */
  private mongoById = new Map<string, MongoConnector>();
  private mongoEngines = new Map<string, MongoAskEngine>();
  private auditSeq = 0;
  private dynamicSeq = 0;
  /** Ids mid-creation, reserved before the first await (see createConnection). */
  private readonly creatingIds = new Set<string>();
  /** Ids this server created at runtime. Anything else was configured by the operator. */
  private readonly dynamicIds = new Set<string>();

  constructor(private readonly config: AskSqlServerConfig) {
    if (typeof config.auth !== 'function') {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: 'AskSqlServerConfig.auth is required',
        userMessage: 'AskSQL server is misconfigured: no auth hook.',
      });
    }
    this.connectors = [...config.connectors];
    this.byId = new Map(this.connectors.map((c) => [c.id, c]));
    for (const m of config.mongoConnectors ?? []) this.mongoById.set(m.id, m);
    this.engine = this.buildEngine();
  }

  /** Null while no databases are configured: createAskSql requires at least one connector. */
  private buildEngine(): ReturnType<typeof createAskSql> | null {
    if (this.connectors.length === 0) return null;
    return createAskSql({ ...this.config.engine, connectors: this.connectors, history: this.history });
  }

  private requireEngine(): ReturnType<typeof createAskSql> {
    if (!this.engine) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: 'no connectors configured',
        userMessage: 'No databases are connected yet. Add one in Settings first.',
      });
    }
    return this.engine;
  }

  /** Dynamic connections change the set the engine plans against, so it is rebuilt rather than mutated. */
  private setConnectors(next: Connector[]): void {
    this.connectors = next;
    this.byId = new Map(next.map((c) => [c.id, c]));
    this.engine = this.buildEngine();
  }

  private isMongo(connectionId: string): boolean {
    return this.mongoById.has(connectionId);
  }

  /** One engine per Mongo connection, built lazily and reused so its catalog cache survives. */
  private mongoEngine(connectionId: string): MongoAskEngine {
    const existing = this.mongoEngines.get(connectionId);
    if (existing) return existing;
    const connector = this.mongoById.get(connectionId);
    if (!connector) {
      throw new AskSqlError('INVALID_INPUT', {
        userMessage: 'Unknown database connection.',
        detail: `no mongo ${connectionId}`,
      });
    }
    const created = createMongoAskSql({
      connector,
      model: this.config.engine.model,
      ...(this.config.engine.policy ? { policy: this.config.engine.policy } : {}),
      ...(this.config.engine.llm ? { llm: this.config.engine.llm } : {}),
      ...(this.config.engine.pruner ? { pruner: this.config.engine.pruner } : {}),
    });
    this.mongoEngines.set(connectionId, created);
    return created;
  }

  /** Route one request. Adapters translate their req/res to this. */
  async handle(req: ServerRequest): Promise<HandlerResponse> {
    try {
      const csrf = crossSiteRejection(req, this.config.requireLoopbackHost === true);
      if (csrf) return csrf;
      const auth = await this.authenticate(req);
      const path = normalizePath(req.path);

      // `return await`, not a bare `return`, so rejections land in this try/catch.
      if (req.method === 'GET' && path === '/connections') return this.listConnections(auth);
      if (req.method === 'POST' && path === '/connections') return await this.createConnection(req, auth);
      if (req.method === 'DELETE' && path.startsWith('/connections/')) {
        return await this.deleteConnection(decodeURIComponent(path.slice('/connections/'.length)), auth);
      }
      if (req.method === 'GET' && path === '/schema') return await this.getSchema(req, auth);
      if (req.method === 'GET' && path === '/health') return this.health(auth);
      if (req.method === 'GET' && path === '/history') return await this.getHistory(req, auth);
      if (req.method === 'POST' && path === '/chat') return await this.chat(req, auth);
      if (req.method === 'POST' && path === '/execute') return await this.execute(req, auth);
      if (req.method === 'POST' && path === '/explain') return await this.explain(req, auth);
      if (req.method === 'POST' && path === '/explainSchema') return await this.explainSchema(req, auth);
      if (req.method === 'POST' && path === '/feedback') return await this.feedback(req, auth);

      return json(404, { error: { code: 'INVALID_INPUT', userMessage: 'Unknown endpoint.', retryable: false } });
    } catch (err) {
      this.reportError(err, req);
      return errorResponse(err);
    }
  }

  /** Best-effort host error hook. Neither a sync throw NOR a rejected async hook may turn one error into two. */
  private reportError(err: unknown, req: ServerRequest): void {
    if (!this.config.onError) return;
    try {
      const r = this.config.onError(err, { method: req.method, path: normalizePath(req.path) }) as unknown;
      // An async hook returns a promise; swallow its rejection so it never becomes an unhandled rejection.
      void Promise.resolve(r).catch(() => {});
    } catch {
      // Swallowed on purpose: the response must go out regardless of the hook.
    }
  }

  private async authenticate(req: ServerRequest): Promise<AuthContext> {
    let ctx: AuthContext | null;
    try {
      ctx = await this.config.auth(req);
    } catch (err) {
      throw new AskSqlError('SERVER_AUTHZ', { detail: `auth hook threw: ${errText(err)}`, cause: err });
    }
    if (!ctx || !Array.isArray(ctx.allowedConnectionIds)) {
      throw new AskSqlError('SERVER_AUTHZ', { detail: 'auth hook returned no context' });
    }
    return ctx;
  }

  private assertAccess(connectionId: string, auth: AuthContext): void {
    if (!this.byId.has(connectionId) && !this.mongoById.has(connectionId)) {
      throw new AskSqlError('INVALID_INPUT', {
        userMessage: 'Unknown database connection.',
        detail: `no such connection ${connectionId}`,
      });
    }
    if (!canAccess(auth, connectionId)) {
      // Same message whether it exists or not - don't leak existence.
      throw new AskSqlError('SERVER_AUTHZ', { detail: `user ${auth.userId} denied ${connectionId}` });
    }
  }

  private resolveConnectionId(req: ServerRequest, auth: AuthContext, fromBody?: string): string {
    const id = fromBody ?? req.query['connectionId'];
    if (id) {
      this.assertAccess(id, auth);
      return id;
    }
    // Default to the caller's first allowed connection.
    const first = auth.allowedConnectionIds.includes(ANY_CONNECTION)
      ? (this.connectors[0]?.id ?? [...this.mongoById.keys()][0])
      : auth.allowedConnectionIds[0];
    if (!first) throw new AskSqlError('SERVER_AUTHZ', { detail: 'user has no connections' });
    this.assertAccess(first, auth);
    return first;
  }

  private listConnections(auth: AuthContext): JsonResponse {
    // Credentials never appear here - id/name/engine only.
    const items = [
      ...this.connectors
        .filter((c) => canAccess(auth, c.id))
        .map((c) => ({ id: c.id, name: c.name, engine: c.engine, database: c.database, capabilities: c.capabilities })),
      ...[...this.mongoById.values()]
        .filter((c) => canAccess(auth, c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          engine: c.engine,
          database: c.database,
          capabilities: MONGO_CAPABILITIES,
        })),
    ];
    return json(200, { connections: items });
  }

  private dynamicOptions(): DynamicConnectionOptions | null {
    const opts = this.config.dynamicConnections;
    return opts?.enabled ? opts : null;
  }

  /** Opens a connection from client-supplied details (see dynamicConnections.ts). Off unless the operator opts in. */
  private async createConnection(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const options = this.dynamicOptions();
    if (!options) {
      return json(404, {
        error: {
          code: 'INVALID_INPUT',
          userMessage: 'This AskSQL server does not accept new connections. Start it with dynamic connections enabled.',
          retryable: false,
        },
      });
    }
    // Same scope rule as deleteConnection: creating a connection dials a host of the caller's
    // choosing with their credentials, so it needs the same standing as using one.
    if (!canAccess(auth, ANY_CONNECTION)) {
      throw new AskSqlError('SERVER_AUTHZ', { detail: `user ${auth.userId} may not create connections` });
    }
    // Through readBody like every other endpoint: malformed JSON (or a null / non-object body)
    // is the CLIENT's mistake - 400 INVALID_INPUT, never a 500 "server misconfigured".
    const spec = (await this.readBody(req)) as unknown as ConnectionSpec;
    for (const [field, value] of [
      ['id', spec.id],
      ['name', spec.name],
    ] as const) {
      if (value !== undefined && typeof value !== 'string') {
        throw new AskSqlError('INVALID_INPUT', {
          detail: `connection spec ${field} must be a string, got ${typeof value}`,
          userMessage: `The connection's ${field} must be a string.`,
        });
      }
    }
    assertSpecAllowed(spec, options);

    const id = spec.id?.trim() || `dyn_${++this.dynamicSeq}`;
    // Reserved synchronously: the driver import and eager connect below both await, so two
    // concurrent POSTs carrying the same explicit id must not both clear this check.
    if (this.byId.has(id) || this.mongoById.has(id) || this.creatingIds.has(id)) {
      throw new AskSqlError('INVALID_INPUT', {
        detail: `duplicate id ${id}`,
        userMessage: 'A connection with that id already exists.',
      });
    }
    this.creatingIds.add(id);
    try {
      if (spec.engine === 'mongodb') {
        const mongo = await createMongoConnector(spec, id);
        await mongo.connect();
        this.mongoById.set(id, mongo);
        return json(201, { connection: { id, name: mongo.name, engine: mongo.engine, database: mongo.database } });
      }
      const connector = await createConnector(spec, id);
      // Connect eagerly, so a bad host or password fails here while the user is still on the form.
      await connector.connect();
      this.setConnectors([...this.connectors, connector]);
      this.dynamicIds.add(id);
      return json(201, {
        connection: { id, name: connector.name, engine: connector.engine, database: connector.database },
      });
    } finally {
      this.creatingIds.delete(id);
    }
  }

  private async deleteConnection(id: string, auth: AuthContext): Promise<JsonResponse> {
    if (!this.dynamicOptions()) {
      return json(404, {
        error: {
          code: 'INVALID_INPUT',
          userMessage: 'This AskSQL server does not manage connections.',
          retryable: false,
        },
      });
    }
    // Deleting dials nothing but removes a connection for everyone, so it needs the standing that
    // creating one needs, not merely permission to query it.
    if (!canAccess(auth, ANY_CONNECTION)) {
      throw new AskSqlError('SERVER_AUTHZ', { detail: `user ${auth.userId} may not remove connections` });
    }
    this.assertAccess(id, auth);
    // An operator-configured connection is not this endpoint's to remove.
    if (!this.dynamicIds.has(id)) {
      return json(403, {
        error: {
          code: 'SERVER_AUTHZ',
          userMessage: 'That connection was configured on the server and cannot be removed here.',
          retryable: false,
        },
      });
    }
    const mongo = this.mongoById.get(id);
    if (mongo) {
      await mongo.close();
      this.mongoById.delete(id);
      this.mongoEngines.delete(id);
      this.dynamicIds.delete(id);
      return json(200, { removed: id });
    }
    // assertAccess already rejected an id in neither map, so a non-mongo id here is a SQL connector.
    const connector = this.byId.get(id)!;
    await connector.close?.();
    this.setConnectors(this.connectors.filter((c) => c.id !== id));
    this.dynamicIds.delete(id);
    return json(200, { removed: id });
  }

  private async getSchema(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const connectionId = this.resolveConnectionId(req, auth);
    const refresh = req.query['refresh'] === '1' || req.query['refresh'] === 'true';
    let catalog;
    if (this.isMongo(connectionId)) {
      // The Mongo engine has no refresh parameter; drop its cached catalog so the next read re-samples.
      const engine = this.mongoEngine(connectionId);
      if (refresh) engine.invalidateCatalog();
      catalog = await engine.catalog();
    } else {
      catalog = await this.requireEngine().catalog(connectionId, { refresh });
    }
    return json(200, { catalog });
  }

  private async getHistory(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const connectionId = this.resolveConnectionId(req, auth);
    const limit = clampInt(req.query['per_page'], 50, 1, 200);
    const page = clampInt(req.query['page'], 1, 1, 1_000_000);
    const offset = (page - 1) * limit;
    const result = await this.history.list(connectionId, { limit, offset, userId: auth.userId });
    return json(200, { items: result.items, total: result.total, page, per_page: limit });
  }

  /** Mongo turns reuse the wire's `sql` field to carry the aggregation-pipeline JSON, with `collection` alongside because execution needs it. */
  private mongoChat(
    question: string,
    connectionId: string,
    req: ServerRequest,
    context?: { question: string; sql: string }[],
  ): StreamResponse {
    const engine = this.mongoEngine(connectionId);
    const mongoContext = (context ?? []).map((t) => ({ question: t.question, pipelineJson: t.sql }));
    const report = (err: unknown): void => this.reportError(err, req);

    const stream = (async function* (): AsyncIterable<ChatStreamEvent> {
      const queue: EngineEvent[] = [];
      let notify: (() => void) | null = null;
      const wake = () => {
        const n = notify;
        notify = null;
        n?.();
      };

      let settled:
        { ok: true; result: Awaited<ReturnType<MongoAskEngine['ask']>> } | { ok: false; error: unknown } | undefined;
      void engine
        .ask(question, {
          context: mongoContext,
          onEvent: (e: EngineEvent) => {
            queue.push(e);
            wake();
          },
          signal: req.signal,
        })
        .then(
          (result) => {
            settled = { ok: true, result };
            wake();
          },
          (error: unknown) => {
            settled = { ok: false, error };
            wake();
          },
        );

      const drain = function* (): Generator<ChatStreamEvent> {
        while (queue.length > 0) {
          const e = queue.shift()!;
          if (e.type === 'stage') yield { type: 'stage', stage: e.stage };
          else if (e.type === 'token') yield { type: 'token', text: e.text };
        }
      };

      while (!settled) {
        yield* drain();
        if (settled) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      yield* drain();

      if (settled.ok) {
        const r = settled.result;
        yield {
          type: 'sql',
          sql: r.pipelineJson,
          collection: r.collection,
          explanation: r.explanation,
          autoLimited: r.autoLimited,
        };
      } else {
        report(settled.error);
        yield { type: 'error', ...AskSqlError.from(settled.error, 'LLM_UNAVAILABLE').toJSON() };
      }
      yield { type: 'done' };
    })();

    return { status: 200, stream };
  }

  private async chat(req: ServerRequest, auth: AuthContext): Promise<StreamResponse> {
    const body = (await this.readBody(req)) as {
      question?: string;
      connectionId?: string;
      context?: { question: string; sql: string }[];
    };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    const question = String(body.question ?? '');
    if (this.isMongo(connectionId))
      return this.mongoChat(question, connectionId, req, AskSqlServer.parseContext(body.context));
    const engine = this.requireEngine();

    type Settled = { ok: true; result: AskResult } | { ok: false; error: unknown };

    // Captured because the generator below is a plain function* with no `this`.
    const report = (err: unknown): void => this.reportError(err, req);

    const stream = (async function* (): AsyncIterable<ChatStreamEvent> {
      const queue: EngineEvent[] = [];
      let notify: (() => void) | null = null;
      const wake = () => {
        const n = notify;
        notify = null;
        n?.();
      };
      const onEvent = (e: EngineEvent) => {
        queue.push(e);
        wake();
      };

      let settled: Settled | undefined;
      void engine
        .ask(question, {
          connectionId,
          context: AskSqlServer.parseContext(body.context),
          onEvent,
          userId: auth.userId,
          signal: req.signal,
        })
        .then(
          (result: AskResult) => {
            settled = { ok: true, result };
            wake();
          },
          (error: unknown) => {
            settled = { ok: false, error };
            wake();
          },
        );

      const drain = function* (): Generator<ChatStreamEvent> {
        while (queue.length > 0) {
          const e = queue.shift()!;
          if (e.type === 'stage') yield { type: 'stage', stage: e.stage };
          else if (e.type === 'token') yield { type: 'token', text: e.text };
        }
      };

      while (!settled) {
        yield* drain();
        if (settled) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      yield* drain();

      if (settled.ok) {
        const r = settled.result;
        yield { type: 'sql', sql: r.sql, explanation: r.explanation, autoLimited: r.guard.autoLimited };
      } else {
        report(settled.error);
        yield { type: 'error', ...AskSqlError.from(settled.error, 'LLM_UNAVAILABLE').toJSON() };
      }
      yield { type: 'done' };
    })();

    return { status: 200, stream };
  }

  private async execute(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const body = (await this.readBody(req)) as {
      sql?: string;
      connectionId?: string;
      question?: string;
      maxRows?: number;
      collection?: string;
    };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    const sql = String(body.sql ?? '');
    if (!sql.trim()) throw new AskSqlError('INVALID_INPUT', { userMessage: 'Provide a SQL statement to run.' });

    if (this.isMongo(connectionId)) {
      const collection = String(body.collection ?? '');
      if (!collection) {
        throw new AskSqlError('INVALID_INPUT', {
          userMessage: 'A MongoDB query needs the collection it runs against.',
        });
      }
      try {
        const result = await this.mongoEngine(connectionId).execute(sql, collection, {
          ...(body.maxRows !== undefined ? { maxRows: body.maxRows } : {}),
          signal: req.signal,
        });
        await this.audit(connectionId, auth, sql, 'allowed', 'ok', result.rowCount);
        return json(200, { result });
      } catch (err) {
        const e = AskSqlError.from(err, 'DB_QUERY_ERROR');
        await this.audit(
          connectionId,
          auth,
          sql,
          e.code === 'GUARD_BLOCKED' ? 'blocked' : 'allowed',
          e.code === 'GUARD_BLOCKED' ? 'blocked' : 'error',
        );
        throw e;
      }
    }

    try {
      const result = await this.requireEngine().execute(sql, {
        connectionId,
        question: body.question,
        maxRows: body.maxRows,
        userId: auth.userId,
        signal: req.signal,
      });
      await this.audit(connectionId, auth, sql, 'allowed', 'ok', result.rowCount);
      return json(200, { result });
    } catch (err) {
      const e = AskSqlError.from(err, 'DB_QUERY_ERROR');
      await this.audit(
        connectionId,
        auth,
        sql,
        e.code === 'GUARD_BLOCKED' ? 'blocked' : 'allowed',
        e.code === 'GUARD_BLOCKED' ? 'blocked' : 'error',
      );
      // On a runtime DB error, offer a corrected query for the user to review and re-run; never auto-run it.
      if (this.config.suggestFixOnError !== false && e.code === 'DB_QUERY_ERROR' && body.question) {
        const fix = await this.requireEngine()
          .suggestFix(sql, { connectionId, question: body.question, errorDetail: e.detail })
          .catch(() => null);
        if (fix) (e as AskSqlError & { suggestedSql?: string }).suggestedSql = fix;
      }
      throw e;
    }
  }

  private async explain(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const body = (await this.readBody(req)) as { sql?: string; connectionId?: string };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    if (this.isMongo(connectionId)) {
      const explanation = await this.mongoEngine(connectionId).explain(String(body.sql ?? ''), { signal: req.signal });
      return json(200, { explanation });
    }
    const explanation = await this.requireEngine().explain(String(body.sql ?? ''), {
      connectionId,
      signal: req.signal,
    });
    return json(200, { explanation });
  }

  /** Prior turns from a client are untrusted: shape-check them so a junk entry cannot 500 or bloat. */
  private static parseContext(raw: unknown): { question: string; sql: string }[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const turns = raw
      .filter((t): t is { question?: unknown; sql?: unknown } => typeof t === 'object' && t !== null)
      .filter((t) => typeof t.sql === 'string' && t.sql.trim().length > 0)
      .slice(-CONTEXT_TURNS)
      .map((t) => ({
        question: typeof t.question === 'string' ? t.question.slice(0, MAX_CONTEXT_FIELD) : '',
        sql: String(t.sql).slice(0, MAX_CONTEXT_FIELD),
      }));
    return turns.length > 0 ? turns : undefined;
  }

  private async explainSchema(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const body = (await this.readBody(req)) as {
      question?: string;
      connectionId?: string;
      context?: { question: string; sql: string }[];
    };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    const question = String(body.question ?? '');
    const answer = this.isMongo(connectionId)
      ? await this.mongoEngine(connectionId).explainSchema(question, {
          signal: req.signal,
          context: AskSqlServer.parseContext(body.context)?.map((t) => ({ question: t.question, pipelineJson: t.sql })),
        })
      : await this.requireEngine().explainSchema(question, {
          connectionId,
          signal: req.signal,
          context: AskSqlServer.parseContext(body.context),
        });
    return json(200, answer);
  }

  private async feedback(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const body = (await this.readBody(req)) as { question?: string; sql?: string; connectionId?: string };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    // Pass the authenticated userId: the few-shot store is per-user, so examples never cross tenants.
    await this.requireEngine().recordFeedback(String(body.question ?? ''), String(body.sql ?? ''), {
      connectionId,
      userId: auth.userId,
    });
    return json(200, { ok: true });
  }

  private health(auth: AuthContext): JsonResponse {
    // Scoped like every other endpoint: a caller sees only the connection ids it may use.
    return json(200, {
      status: 'ok',
      connections: [
        ...this.connectors.filter((c) => canAccess(auth, c.id)).map((c) => ({ id: c.id, engine: c.engine })),
        ...[...this.mongoById.values()]
          .filter((c) => canAccess(auth, c.id))
          .map((c) => ({ id: c.id, engine: c.engine })),
      ],
    });
  }

  private async readBody(req: ServerRequest): Promise<Record<string, unknown>> {
    const raw = await req.json().catch((err: unknown) => {
      // Keep the adapter's own reason (e.g. body too large) rather than labelling every failure invalid JSON.
      if (AskSqlError.is(err)) throw err;
      throw new AskSqlError('INVALID_INPUT', { userMessage: 'Request body must be valid JSON.' });
    });
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    return {};
  }

  private async audit(
    connectionId: string,
    auth: AuthContext,
    sql: string,
    verdict: 'allowed' | 'blocked',
    status: 'ok' | 'blocked' | 'error',
    rowCount?: number,
  ): Promise<void> {
    if (!this.config.audit) return;
    try {
      await this.config.audit.write({
        id: `a_${Date.now().toString(36)}_${(this.auditSeq++).toString(36)}`,
        at: new Date().toISOString(),
        connectionId,
        userId: auth.userId,
        sql,
        status,
        guardVerdict: verdict,
        ...(rowCount !== undefined ? { rowCount } : {}),
      });
    } catch {
      // Audit failure must never block a read.
    }
  }

  get maxBodyBytes(): number {
    return this.config.maxBodyBytes ?? DEFAULT_MAX_BODY;
  }

  async close(): Promise<void> {
    // engine is null on a mongo-only (or empty) server.
    if (this.engine) await this.engine.close();
    for (const mongo of this.mongoById.values()) {
      await mongo.close().catch(() => {});
    }
    this.mongoEngines.clear();
  }
}

function normalizePath(path: string): string {
  const clean = path.split('?')[0]!.replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

function json(status: number, body: unknown): JsonResponse {
  return { status, body };
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = raw === undefined ? dflt : Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(Math.floor(n), max));
}

export function errorResponse(err: unknown): JsonResponse {
  const e = AskSqlError.from(err, 'CONFIG_ERROR');
  const status =
    e.code === 'SERVER_AUTHZ'
      ? 403
      : e.code === 'INVALID_INPUT'
        ? 400
        : e.code === 'GUARD_BLOCKED'
          ? 400
          : e.code === 'DB_AUTH' || e.code === 'CONFIG_ERROR'
            ? 500
            : e.code === 'DB_UNREACHABLE' || e.code === 'LLM_UNREACHABLE'
              ? 502
              : e.code === 'DB_TIMEOUT' || e.code === 'LLM_TIMEOUT'
                ? 504
                : e.code === 'LLM_RATE_LIMIT'
                  ? 429
                  : e.code === 'LLM_BILLING'
                    ? 402
                    : 200;
  const suggestedSql = (e as { suggestedSql?: string }).suggestedSql;
  return {
    status: status === 200 ? 400 : status,
    body: { error: e.toJSON(), ...(suggestedSql ? { suggestedSql } : {}) },
  };
}
