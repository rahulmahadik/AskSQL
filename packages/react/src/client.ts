/**
 * AskSQL client transports.
 *
 * Two ways the React UI reaches an engine:
 * - HttpTransport -> talks to an `@asksql/server` sidecar (credentials stay
 * server-side). Streams /chat as SSE.
 * - LocalTransport -> wraps a core `AskSqlEngine` running in the browser
 * (the zero-backend DuckDB file mode).
 *
 * Both satisfy the same `Transport` interface so components are transport-
 * agnostic.
 */

import type {
  AskSqlEngine,
  ExecuteOptions,
  ResultSet,
  SchemaCatalog,
} from '@asksql/core';

export interface ConnectionSummary {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  /** The connected database / file name, for display. */
  readonly database?: string;
}

export interface ChatEvent {
  readonly type: 'stage' | 'token' | 'sql' | 'error' | 'done';
  readonly stage?: string;
  readonly text?: string;
  readonly sql?: string;
  readonly explanation?: string;
  readonly autoLimited?: boolean;
  readonly code?: string;
  readonly userMessage?: string;
  readonly retryable?: boolean;
}

export interface AskParams {
  readonly question: string;
  readonly connectionId?: string;
  readonly context?: readonly { question: string; sql: string }[];
  readonly signal?: AbortSignal;
}

export interface Transport {
  listConnections(): Promise<ConnectionSummary[]>;
  schema(connectionId?: string, refresh?: boolean): Promise<SchemaCatalog>;
  chat(params: AskParams): AsyncIterable<ChatEvent>;
  execute(sql: string, opts?: ExecuteOptions & { connectionId?: string; question?: string }): Promise<ResultSet>;
  explain(sql: string, connectionId?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// SSE line parser (pure - unit tested)
// ---------------------------------------------------------------------------

/**
 * Incrementally parse an SSE byte stream into `data:` JSON payloads.
 * Handles chunk boundaries splitting an event mid-line and ignores
 * comment (`:`) heartbeat lines.
 */
export class SseParser {
  private buffer = '';
  push(chunk: string): ChatEvent[] {
    this.buffer += chunk;
    const events: ChatEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue; // heartbeat / comment
      const payload = dataLines.join('\n');
      try {
        events.push(JSON.parse(payload) as ChatEvent);
      } catch {
        // ignore malformed frame
      }
    }
    return events;
  }
}

// ---------------------------------------------------------------------------
// HTTP transport (sidecar)
// ---------------------------------------------------------------------------

export interface HttpTransportOptions {
  /** Sidecar base URL, e.g. "/asksql" or "https://api.example.com/asksql". */
  readonly baseUrl: string;
  /** Extra headers (auth token, etc.) merged into every request. */
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
}

export class HttpTransport implements Transport {
  private readonly f: typeof fetch;
  constructor(private readonly opts: HttpTransportOptions) {
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const base = this.opts.baseUrl.replace(/\/$/, '');
    const qs = query
      ? '?' + Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')
      : '';
    return `${base}${path}${qs}`;
  }

  private headers(json = true): Record<string, string> {
    return {...(json ? { 'Content-Type': 'application/json' } : {}),...(this.opts.headers ?? {}) };
  }

  /**
   * fetch rejects (rather than returning a non-ok Response) only for
   * transport-level failures: the server is unreachable, the baseUrl is wrong,
   * or CORS blocked the request before any response existed. Left raw, those
   * surface as a bare `TypeError: Failed to fetch` that looks identical to a
   * 5xx. Turn them into a typed NETWORK_ERROR with an actionable message; a user
   * abort is passed through untouched.
   */
  private async doFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.f(url, init);
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
      throw new TransportError(
        'NETWORK_ERROR',
        'Could not reach the AskSQL server. Check that it is running and that its address allows requests from this page (CORS/baseUrl).',
        undefined,
        undefined,
        true,
      );
    }
  }

  private async unwrap<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (body['error'] as { userMessage?: string; code?: string; retryable?: boolean }) ?? {};
      const suggestedSql = typeof body['suggestedSql'] === 'string' ? (body['suggestedSql'] as string) : undefined;
      throw new TransportError(err.code ?? 'HTTP_ERROR', err.userMessage ?? `Request failed (${res.status}).`, res.status, suggestedSql, err.retryable);
    }
    return body as T;
  }

  async listConnections(): Promise<ConnectionSummary[]> {
    const res = await this.doFetch(this.url('/connections'), { headers: this.headers(false) });
    const body = await this.unwrap<{ connections: ConnectionSummary[] }>(res);
    return body.connections;
  }

  async schema(connectionId?: string, refresh?: boolean): Promise<SchemaCatalog> {
    const res = await this.doFetch(this.url('/schema', { connectionId, refresh: refresh ? '1' : undefined }), { headers: this.headers(false) });
    const body = await this.unwrap<{ catalog: SchemaCatalog }>(res);
    return body.catalog;
  }

  async *chat(params: AskParams): AsyncIterable<ChatEvent> {
    const res = await this.doFetch(this.url('/chat'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ question: params.question, connectionId: params.connectionId, context: params.context }),
      signal: params.signal,
    });
    if (!res.ok || !res.body) {
      await this.unwrap(res); // throws the mapped error
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        yield event;
        if (event.type === 'done') return;
      }
    }
  }

  async execute(sql: string, opts?: ExecuteOptions & { connectionId?: string; question?: string }): Promise<ResultSet> {
    const res = await this.doFetch(this.url('/execute'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ sql, connectionId: opts?.connectionId, question: opts?.question, maxRows: opts?.maxRows }),
      signal: opts?.signal,
    });
    const body = await this.unwrap<{ result: ResultSet }>(res);
    return body.result;
  }

  async explain(sql: string, connectionId?: string): Promise<string> {
    const res = await this.doFetch(this.url('/explain'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ sql, connectionId }),
    });
    const body = await this.unwrap<{ explanation: string }>(res);
    return body.explanation;
  }
}

export class TransportError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    readonly status?: number,
    /** A corrected query the server suggested for a failed run (opt-in to apply). */
    readonly suggestedSql?: string,
    readonly retryable?: boolean,
  ) {
    super(userMessage);
    this.name = 'TransportError';
  }
}

// ---------------------------------------------------------------------------
// Local transport (in-browser engine - DuckDB file mode)
// ---------------------------------------------------------------------------

export class LocalTransport implements Transport {
  constructor(private readonly engine: AskSqlEngine) {}

  async listConnections(): Promise<ConnectionSummary[]> {
    return this.engine.connectors.map((c) => ({ id: c.id, name: c.name, engine: c.engine, database: c.database }));
  }
  schema(connectionId?: string, refresh?: boolean): Promise<SchemaCatalog> {
    return this.engine.catalog(connectionId, { refresh: refresh ?? false });
  }
  async *chat(params: AskParams): AsyncIterable<ChatEvent> {
    const events: ChatEvent[] = [];
    let done = false;
    let notify: (() => void) | null = null;
    const push = (e: ChatEvent) => {
      events.push(e);
      notify?.();
    };
    this.engine
      .ask(params.question, {
        connectionId: params.connectionId,
        context: params.context,
        signal: params.signal,
        onEvent: (e) => {
          if (e.type === 'stage') push({ type: 'stage', stage: e.stage });
          else if (e.type === 'token') push({ type: 'token', text: e.text });
        },
      })
      .then((r) => {
        push({ type: 'sql', sql: r.sql, explanation: r.explanation, autoLimited: r.guard.autoLimited });
        push({ type: 'done' });
        done = true;
        notify?.();
      })
      .catch((err: unknown) => {
        const e = err as { code?: string; userMessage?: string; retryable?: boolean };
        push({ type: 'error', code: e.code ?? 'LLM_UNAVAILABLE', userMessage: e.userMessage ?? 'Something went wrong.', retryable: e.retryable ?? false });
        push({ type: 'done' });
        done = true;
        notify?.();
      });

    for (;;) {
      while (events.length > 0) yield events.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    }
    while (events.length > 0) yield events.shift()!;
  }
  execute(sql: string, opts?: ExecuteOptions & { connectionId?: string; question?: string }): Promise<ResultSet> {
    return this.engine.execute(sql, opts);
  }
  explain(sql: string, connectionId?: string): Promise<string> {
    return this.engine.explain(sql, { connectionId });
  }
}
