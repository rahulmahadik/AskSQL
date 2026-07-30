/**
 * Framework-agnostic AskSQL server core: one `handle(req)` entry maps the
 * sidecar's HTTP contract onto the engine. Guarantees enforced once for every adapter:
 * - Auth hook runs first; failure/empty -> 401/403, never fail-open.
 * - Every connectionId is checked against the caller's scope.
 * - The guard runs server-side on every execute (engine-enforced).
 * - Errors serialize via AskSqlError.toJSON -> code + userMessage only, never credentials/detail/stack.
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
      throw new AskSqlError('INVALID_INPUT', { userMessage: 'Unknown database connection.', detail: `no mongo ${connectionId}` });
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
      const auth = await this.authenticate(req);
      const path = normalizePath(req.path);

      // `return await` (not bare `return`) so rejected promises are caught
      // by this try/catch and mapped to an error response, never escaping.
      if (req.method === 'GET' && path === '/connections') return this.listConnections(auth);
      if (req.method === 'POST' && path === '/connections') return await this.createConnection(req);
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
      // An async hook returns a promise; swallow its rejection too, or it would
      // become an unhandled rejection (which crashes Node by default).
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
        .map((c) => ({ id: c.id, name: c.name, engine: c.engine, database: c.database, capabilities: MONGO_CAPABILITIES })),
    ];
    return json(200, { connections: items });
  }

  private dynamicOptions(): DynamicConnectionOptions | null {
    const opts = this.config.dynamicConnections;
    return opts?.enabled ? opts : null;
  }

  /** Opens a connection from client-supplied details (see dynamicConnections.ts). Off unless the operator opts in. */
  private async createConnection(req: ServerRequest): Promise<JsonResponse> {
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
    const spec = (await req.json()) as ConnectionSpec;
    assertSpecAllowed(spec, options);

    const id = spec.id?.trim() || `dyn_${++this.dynamicSeq}`;
    // Reserved SYNCHRONOUSLY: the driver import and eager connect below both
    // await, so without this two concurrent POSTs with the same explicit id
    // would each pass the duplicate check and the second would clobber the first.
    if (this.byId.has(id) || this.mongoById.has(id) || this.creatingIds.has(id)) {
      throw new AskSqlError('INVALID_INPUT', { detail: `duplicate id ${id}`, userMessage: 'A connection with that id already exists.' });
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
      // Connect eagerly: a bad host or password should fail here, while the user
      // is looking at the form, not later inside an unrelated question.
      await connector.connect();
      this.setConnectors([...this.connectors, connector]);
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
        error: { code: 'INVALID_INPUT', userMessage: 'This AskSQL server does not manage connections.', retryable: false },
      });
    }
    // Same scope rule as every query endpoint: a caller who cannot use a
    // connection cannot tear it down either.
    this.assertAccess(id, auth);
    const mongo = this.mongoById.get(id);
    if (mongo) {
      await mongo.close();
      this.mongoById.delete(id);
      this.mongoEngines.delete(id);
      return json(200, { removed: id });
    }
    const connector = this.byId.get(id);
    if (!connector) {
      return json(404, { error: { code: 'INVALID_INPUT', userMessage: 'No such connection.', retryable: false } });
    }
    await connector.close?.();
    this.setConnectors(this.connectors.filter((c) => c.id !== id));
    return json(200, { removed: id });
  }

  private async getSchema(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const connectionId = this.resolveConnectionId(req, auth);
    const refresh = req.query['refresh'] === '1' || req.query['refresh'] === 'true';
    const catalog = this.isMongo(connectionId)
      ? await this.mongoEngine(connectionId).catalog()
      : await this.requireEngine().catalog(connectionId, { refresh });
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

      let settled: { ok: true; result: Awaited<ReturnType<MongoAskEngine['ask']>> } | { ok: false; error: unknown } | undefined;
      void engine.ask(question, { context: mongoContext, onEvent: (e: EngineEvent) => { queue.push(e); wake(); } }).then(
        (result) => { settled = { ok: true, result }; wake(); },
        (error: unknown) => { settled = { ok: false, error }; wake(); },
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
        await new Promise<void>((resolve) => { notify = resolve; });
      }
      yield* drain();

      if (settled.ok) {
        const r = settled.result;
        yield { type: 'sql', sql: r.pipelineJson, collection: r.collection, explanation: r.explanation, autoLimited: r.autoLimited };
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
    if (this.isMongo(connectionId)) return this.mongoChat(question, connectionId, req, body.context);
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
      void engine.ask(question, { connectionId, context: body.context, onEvent, userId: auth.userId }).then(
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
        throw new AskSqlError('INVALID_INPUT', { userMessage: 'A MongoDB query needs the collection it runs against.' });
      }
      try {
        const result = await this.mongoEngine(connectionId).execute(sql, collection, {
          ...(body.maxRows !== undefined ? { maxRows: body.maxRows } : {}),
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
      // On a runtime DB error, offer a corrected query for the user to review
      // and re-run (never auto-run). Needs the original question for context.
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
      const explanation = await this.mongoEngine(connectionId).explain(String(body.sql ?? ''));
      return json(200, { explanation });
    }
    const explanation = await this.requireEngine().explain(String(body.sql ?? ''), { connectionId });
    return json(200, { explanation });
  }

  private async explainSchema(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const body = (await this.readBody(req)) as { question?: string; connectionId?: string };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    if (this.isMongo(connectionId)) {
      throw new AskSqlError('INVALID_INPUT', {
        detail: 'explainSchema unsupported for mongo',
        userMessage: 'Plain-language schema answers are not available for MongoDB connections yet.',
      });
    }
    const answer = await this.requireEngine().explainSchema(String(body.question ?? ''), { connectionId });
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
    // Scope this like every other endpoint. Listing every connector let a caller
    // enumerate ids they have no access to - and those ids are exactly what
    // /schema and /execute take, so it was a targeting primitive.
    return json(200, {
      status: 'ok',
      connections: [
        ...this.connectors.filter((c) => canAccess(auth, c.id)).map((c) => ({ id: c.id, engine: c.engine })),
        ...[...this.mongoById.values()].filter((c) => canAccess(auth, c.id)).map((c) => ({ id: c.id, engine: c.engine })),
      ],
    });
  }

  private async readBody(req: ServerRequest): Promise<Record<string, unknown>> {
    const raw = await req.json().catch((err: unknown) => {
      // The adapter may reject with a real reason (e.g. body too large); keep it
      // instead of mislabeling every failure as invalid JSON.
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
      // Audit failure must never block a read. Surfaced via health
      // in a fuller impl; swallowed here so the query still returns.
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
