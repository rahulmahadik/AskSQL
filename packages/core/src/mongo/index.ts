/**
 * The MongoDB engine path. A non-SQL parallel to the SQL pipeline: a question
 * becomes a read-only aggregation pipeline, validated by an allowlist guard, and
 * run against a MongoConnector. Exported from @asksql/core under this namespace.
 */

export {
  DEFAULT_MONGO_GUARD_POLICY,
  guardPipeline,
  parsePipeline,
  type MongoGuardPolicy,
  type MongoGuardVerdict,
} from './guard.js';
export { extractPipeline, type MongoExtraction } from './extract.js';
export {
  buildPipelineSystem,
  buildPipelineUser,
  buildMongoRepairUser,
  buildMongoExplainSystem,
  buildMongoExplainUser,
  type MongoContextTurn,
  type MongoFewShot,
  type BuildPipelineUserArgs,
  type BuildMongoRepairArgs,
} from './prompts.js';
export {
  createMongoAskSql,
  type MongoConnector,
  type MongoAskConfig,
  type MongoAskOptions,
  type MongoAskResult,
  type MongoAskEngine,
} from './engine.js';
