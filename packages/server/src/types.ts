/**
 * Server sidecar contract: the host app owns identity, AskSQL enforces scope.
 * Credentials live only here, never in a client-visible response.
 */

import type { MongoConnector } from '@asksql/core/mongo';
import type { DynamicConnectionOptions } from './dynamicConnections.js';
import type { AskSqlConfig, Connector, HistoryEntry } from '@asksql/core';

/** Result of the host's auth hook. */
export interface AuthContext {
  readonly userId: string;
  /** Connection ids this user may reach. Enforced on every endpoint. */
  readonly allowedConnectionIds: readonly string[];
}

/**
 * The host resolves identity from its own session/JWT and returns the caller's scope.
 * Throwing or returning null denies the request; the server never fails open.
 */
export type AuthHook = (req: ServerRequest) => Promise<AuthContext | null> | AuthContext | null;

/** Minimal framework-agnostic request view. */
export interface ServerRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  json(): Promise<unknown>;
  /** Aborted when the client goes away; the handler passes it on so the model call and query stop too. */
  readonly signal?: AbortSignal;
}

export interface AuditRecord extends HistoryEntry {
  readonly userId: string;
  readonly guardVerdict: 'allowed' | 'blocked';
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

export interface AskSqlServerConfig {
  /** All SQL connections the server can reach (with credentials). */
  readonly connectors: readonly Connector[];
  /** MongoDB connections. Separate because Mongo is not a SQL `Connector`. */
  readonly mongoConnectors?: readonly MongoConnector[];
  /** Engine settings shared by all requests (model, policy, pruner, llm). */
  readonly engine: Omit<AskSqlConfig, 'connectors' | 'history'>;
  /** Identity + scope resolver. Required - there is no anonymous default. */
  readonly auth: AuthHook;
  readonly audit?: AuditSink;
  /**
   * Let clients create connections at runtime via POST /connections, so a browser extension can
   * offer a host/port/user/password form. Off unless explicitly enabled.
   */
  /**
   * Reject any request whose Host is not loopback. The CLI sets this for a loopback bind, where a
   * non-loopback Host is a DNS-rebinding attempt; a hosted deployment leaves it off and uses CORS.
   */
  readonly requireLoopbackHost?: boolean;
  readonly dynamicConnections?: DynamicConnectionOptions;
  /** Max request body bytes. Default 64 KB. */
  readonly maxBodyBytes?: number;
  /**
   * On a database error, ask the model for a corrected query and return it as `suggestedSql`
   * for the user to review and re-run. Costs one extra model call per failure. Default: true.
   */
  readonly suggestFixOnError?: boolean;
  /**
   * Called for every error the server turns into a response, so a host can log it; the wire
   * response never carries internal detail. Best-effort: a throw from the hook is swallowed.
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
  | {
      readonly type: 'sql';
      readonly sql: string;
      readonly explanation?: string;
      readonly autoLimited: boolean;
      /** MongoDB only: the collection the pipeline runs against, required to execute it. */
      readonly collection?: string;
    }
  | { readonly type: 'error'; readonly code: string; readonly userMessage: string; readonly retryable: boolean }
  | { readonly type: 'done' };
