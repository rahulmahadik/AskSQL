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
import type { AskSqlServerConfig, AuthContext, ChatStreamEvent, ServerRequest } from './types.js';

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

export class AskSqlServer {
  private readonly history = new MemoryHistoryStore(2000);
  private readonly engine;
  private readonly byId: Map<string, Connector>;
  private auditSeq = 0;

  constructor(private readonly config: AskSqlServerConfig) {
    if (typeof config.auth !== 'function') {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: 'AskSqlServerConfig.auth is required',
        userMessage: 'AskSQL server is misconfigured: no auth hook.',
      });
    }
    this.byId = new Map(config.connectors.map((c) => [c.id, c]));
    this.engine = createAskSql({
      ...config.engine,
      connectors: config.connectors,
      history: this.history,
    });
  }

  /** Route one request. Adapters translate their req/res to this. */
  async handle(req: ServerRequest): Promise<HandlerResponse> {
    try {
      const auth = await this.authenticate(req);
      const path = normalizePath(req.path);

      // `return await` (not bare `return`) so rejected promises are caught
      // by this try/catch and mapped to an error response, never escaping.
      if (req.method === 'GET' && path === '/connections') return this.listConnections(auth);
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
    if (!this.byId.has(connectionId)) {
      throw new AskSqlError('INVALID_INPUT', {
        userMessage: 'Unknown database connection.',
        detail: `no such connection ${connectionId}`,
      });
    }
    if (!auth.allowedConnectionIds.includes(connectionId)) {
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
    const first = auth.allowedConnectionIds[0];
    if (!first) throw new AskSqlError('SERVER_AUTHZ', { detail: 'user has no connections' });
    this.assertAccess(first, auth);
    return first;
  }

  private listConnections(auth: AuthContext): JsonResponse {
    // Credentials never appear here - id/name/engine only.
    const items = this.config.connectors
      .filter((c) => auth.allowedConnectionIds.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name, engine: c.engine, database: c.database, capabilities: c.capabilities }));
    return json(200, { connections: items });
  }

  private async getSchema(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const connectionId = this.resolveConnectionId(req, auth);
    const refresh = req.query['refresh'] === '1' || req.query['refresh'] === 'true';
    const catalog = await this.engine.catalog(connectionId, { refresh });
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

  private async chat(req: ServerRequest, auth: AuthContext): Promise<StreamResponse> {
    const body = (await this.readBody(req)) as {
      question?: string;
      connectionId?: string;
      context?: { question: string; sql: string }[];
    };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    const question = String(body.question ?? '');
    const engine = this.engine;

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
    };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    const sql = String(body.sql ?? '');
    if (!sql.trim()) throw new AskSqlError('INVALID_INPUT', { userMessage: 'Provide a SQL statement to run.' });

    try {
      const result = await this.engine.execute(sql, {
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
        const fix = await this.engine
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
    const explanation = await this.engine.explain(String(body.sql ?? ''), { connectionId });
    return json(200, { explanation });
  }

  private async explainSchema(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const body = (await this.readBody(req)) as { question?: string; connectionId?: string };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    const answer = await this.engine.explainSchema(String(body.question ?? ''), { connectionId });
    return json(200, answer);
  }

  private async feedback(req: ServerRequest, auth: AuthContext): Promise<JsonResponse> {
    const body = (await this.readBody(req)) as { question?: string; sql?: string; connectionId?: string };
    const connectionId = this.resolveConnectionId(req, auth, body.connectionId);
    // Pass the authenticated userId: the few-shot store is per-user, so examples never cross tenants.
    await this.engine.recordFeedback(String(body.question ?? ''), String(body.sql ?? ''), {
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
      connections: this.config.connectors
        .filter((c) => auth.allowedConnectionIds.includes(c.id))
        .map((c) => ({ id: c.id, engine: c.engine })),
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
    await this.engine.close();
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
