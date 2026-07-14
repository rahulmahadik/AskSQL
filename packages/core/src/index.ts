/**
 * @asksql/core - the AskSQL engine.
 *
 * Zero database drivers live here. Connectors come from adapter packages
 * (`@asksql/postgres`, `@asksql/mysql`, `@asksql/sqlite`, `@asksql/duckdb`);
 * models come from AI SDK provider packages resolved via `resolveModel`.
 */

export * from './types.js';
export { AskSqlError, type ErrorCode, type AskSqlErrorOptions } from './errors.js';
export {
  guardSql,
  resolveGuardPolicy,
  DEFAULT_GUARD_POLICY,
  type GuardInput,
} from './guard.js';
export { stripCommentsAndStrings, hasMultipleStatements } from './strip.js';
export {
  POSTGRES_DIALECT,
  MYSQL_DIALECT,
  SQLITE_DIALECT,
  DUCKDB_DIALECT,
} from './dialects.js';
export {
  formatCatalogForPrompt,
  pruneCatalog,
  joinGraph,
  estimateTokens,
  type PruneResult,
} from './catalog.js';
export { extractSql, extractImpossible, type Extraction } from './extract.js';
export { classifyColumnKind } from './coltype.js';
export {
  buildSqlSystem,
  buildSqlUser,
  buildRepairUser,
  buildExplainSystem,
  buildExplainUser,
} from './prompt.js';
export { callModel, classifyLlmError, type LlmCallInput, type LlmCallResult } from './llm.js';
export { resolveModel, type ProviderConfig, type ProviderName } from './providers.js';
export { MemoryHistoryStore, MemoryFewShotStore } from './history.js';
export {
  createAskSql,
  firstUnknownTable,
  type AskSqlEngine,
  type ExecuteEngineOptions,
  type ExplainOptions,
  type CatalogOptions,
} from './engine.js';
