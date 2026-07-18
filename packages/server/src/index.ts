/**
 * @asksql/server - credential-holding sidecar for AskSQL.
 *
 * The Express adapter is at `@asksql/server/express`; the framework-agnostic
 * core (`AskSqlServer`) is here for Next.js route handlers, Fastify, or a
 * standalone host.
 */

export { AskSqlServer, isStream, errorResponse } from './handler.js';
export type { JsonResponse, StreamResponse, HandlerResponse } from './handler.js';
export type {
  AskSqlServerConfig,
  ErrorContext,
  AuthHook,
  AuthContext,
  ServerRequest,
  AuditSink,
  AuditRecord,
  ChatStreamEvent,
} from './types.js';
