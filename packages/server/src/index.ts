/**
 * @asksql/server - credential-holding sidecar for AskSQL. The Express adapter is at
 * `@asksql/server/express`; the framework-agnostic core (`AskSqlServer`) is here.
 */

export { AskSqlServer, isStream, errorResponse } from './handler.js';
export { ANY_CONNECTION } from './handler.js';
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
export {
  ENGINE_DEFAULTS,
  type ConnectionSpec,
  type DynamicConnectionOptions,
  type DynamicEngine,
} from './dynamicConnections.js';
export { parseArgs, buildServer, createRequestListener, CliError, USAGE, type CliOptions } from './cli.js';
