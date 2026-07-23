/**
 * Server sidecar contract. The host app owns identity; AskSQL enforces
 * scope. Credentials live only here - never serialized to a
 * client-visible response.
 */

import type { AskSqlConfig, Connector, HistoryEntry } from '@asksql/core';

/** Result of the host's auth hook. */
export interface AuthContext {
  readonly userId: string;
  /** Connection ids this user may reach. Enforced on every endpoint. */
  readonly allowedConnectionIds: readonly string[];
}

/**
 * The host resolves identity from its own session/JWT and returns the
 * caller's scope. Throwing (or returning null) denies the request - the
 * server never fails open to all connections.
 */
export type AuthHook = (req: ServerRequest) => Promise<AuthContext | null> | AuthContext | null;

/** Minimal framework-agnostic request view. */
export interface ServerRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  json(): Promise<unknown>;
}

export interface AuditRecord extends HistoryEntry {
  readonly userId: string;
  readonly guardVerdict: 'allowed' | 'blocked';
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

export interface AskSqlServerConfig {
  /** All connections the server can reach (with credentials). */
  readonly connectors: readonly Connector[];
  /** Engine settings shared by all requests (model, policy, pruner, llm). */
  readonly engine: Omit<AskSqlConfig, 'connectors' | 'history'>;
  /** Identity + scope resolver. Required - there is no anonymous default. */
  readonly auth: AuthHook;
  readonly audit?: AuditSink;
  /** Max request body bytes. Default 64 KB. */
  readonly maxBodyBytes?: number;
  /**
   * When a run fails with a database error, ask the model for a corrected query
   * and return it as `suggestedSql` for the user to review and re-run (never
   * auto-run). Costs one extra model call per failed query. Default: true.
   * Set false to disable.
   */
  readonly suggestFixOnError?: boolean;
  /**
   * Called for every error the server turns into a response, so a host can log
   * or report it (the wire response never includes internal detail). Best-effort:
   * a throw from the hook is swallowed so it can never break the response.
   */
  readonly onError?: (err: unknown, context: ErrorContext) => void;
}

/** Where an error surfaced, passed to `onError`. */
export interface ErrorContext {
  readonly method: string;
  readonly path: string;
}

/** Streaming event emitted by POST /chat (SSE). */
export type ChatStreamEvent =
  | { readonly type: 'stage'; readonly stage: string }
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'sql'; readonly sql: string; readonly explanation: string; readonly autoLimited: boolean }
  | { readonly type: 'error'; readonly code: string; readonly userMessage: string; readonly retryable: boolean }
  | { readonly type: 'done' };
