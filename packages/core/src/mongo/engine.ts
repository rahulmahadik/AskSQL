/**
 * The MongoDB engine path: a non-SQL parallel to the SQL EnginePipeline.
 *
 * A question becomes a single read-only aggregation pipeline through the same
 * ask -> extract -> guard -> (repair) loop, then executes against a MongoConnector.
 * MongoDB has no read-only session, so guardPipeline is re-run on every execute.
 */

import { AskSqlError } from '../errors.js';
import { callModel } from '../llm.js';
import { pruneCatalog } from '../catalog.js';
import { closestTableName } from '../schema-match.js';
import type {
  EngineEvent,
  ExecuteOptions,
  LlmSettings,
  ModelLike,
  PrunerSettings,
  ResultSet,
  SchemaCatalog,
} from '../types.js';
import {
  DEFAULT_MONGO_GUARD_POLICY,
  guardPipeline,
  parsePipeline,
  type MongoGuardPolicy,
  type MongoGuardVerdict,
} from './guard.js';
import { extractImpossible, extractPipeline } from './extract.js';
import {
  buildMongoExplainSystem,
  buildMongoExplainUser,
  buildMongoRepairUser,
  buildPipelineSystem,
  buildPipelineUser,
  type GlossaryEntry,
  type MongoContextTurn,
} from './prompts.js';

const MAX_REPAIRS = 2;
const CATALOG_TTL_MS = 300_000;
// A catalog carrying warnings (per-collection sample failures) is partial; cache it
// briefly so a transient failure heals on the next ask instead of persisting 5 minutes.
const WARNED_CATALOG_TTL_MS = 30_000;
const MAX_QUESTION_LENGTH = 10_000;

/**
 * A MongoDB data source. Unlike the SQL Connector, results are produced from a
 * (collection, pipeline) pair rather than a SQL string; introspection is
 * sampling-based and lives in the connector.
 */
export interface MongoConnector {
  readonly id: string;
  readonly name: string;
  readonly engine: 'mongodb';
  readonly database?: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  introspect(): Promise<SchemaCatalog>;
  aggregate(collection: string, pipeline: unknown[], opts?: ExecuteOptions): Promise<ResultSet>;
}

export interface MongoAskConfig {
  readonly connector: MongoConnector;
  readonly model: ModelLike;
  readonly policy?: Partial<MongoGuardPolicy>;
  readonly llm?: LlmSettings;
  readonly pruner?: PrunerSettings;
  readonly glossary?: readonly GlossaryEntry[];
  readonly customInstructions?: string;
  readonly onEvent?: (event: EngineEvent) => void;
}

export interface MongoAskOptions {
  readonly signal?: AbortSignal;
  readonly context?: readonly MongoContextTurn[];
  /** Per-ask progress handler; overrides the engine-level onEvent for this call. */
  readonly onEvent?: (event: EngineEvent) => void;
}

export interface MongoAskResult {
  readonly pipelineJson: string;
  readonly collection: string;
  readonly explanation: string;
  readonly autoLimited: boolean;
  readonly loweredLimit: boolean;
  readonly warnings: readonly string[];
  readonly repairs: number;
}

export interface MongoAskEngine {
  ask(question: string, opts?: MongoAskOptions): Promise<MongoAskResult>;
  execute(pipelineJson: string, collection: string, opts?: ExecuteOptions): Promise<ResultSet>;
  explain(pipelineJson: string, opts?: { signal?: AbortSignal }): Promise<string>;
  catalog(): Promise<SchemaCatalog>;
  invalidateCatalog(): void;
}

const looksLikeRefusal = (text: string): boolean =>
  /\b(i can(?:no|')t|i cannot|i am unable|i'm unable|i'm sorry|as an ai)\b/iu.test(text);

/** Resolve a collection name case-insensitively to its real casing (Mongo names are case-sensitive). */
function resolveCollection(name: string, catalog: SchemaCatalog): string | null {
  const lower = name.toLowerCase();
  for (const t of catalog.tables) if (t.name.toLowerCase() === lower) return t.name;
  return null;
}

/** Rewrite $lookup/$graphLookup `from` and $unionWith targets to their real catalog casing. */
function rewriteJoinTargets(node: unknown, resolve: (n: string) => string | null): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteJoinTargets(n, resolve));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === '$lookup' || k === '$graphLookup') && v && typeof v === 'object' && !Array.isArray(v)) {
        const spec = { ...(v as Record<string, unknown>) };
        if (typeof spec['from'] === 'string') spec['from'] = resolve(spec['from']) ?? spec['from'];
        out[k] = rewriteJoinTargets(spec, resolve);
      } else if (k === '$unionWith') {
        if (typeof v === 'string') out[k] = resolve(v) ?? v;
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
          const spec = { ...(v as Record<string, unknown>) };
          if (typeof spec['coll'] === 'string') spec['coll'] = resolve(spec['coll']) ?? spec['coll'];
          out[k] = rewriteJoinTargets(spec, resolve);
        } else out[k] = v;
      } else {
        out[k] = rewriteJoinTargets(v, resolve);
      }
    }
    return out;
  }
  return node;
}

/**
 * Resolve every $lookup/$graphLookup/$unionWith target in a guarded pipeline against
 * the catalog and rewrite it to real casing. A hallucinated or wrong-cased target
 * silently returns empty joins, so an unresolved name is reported for the caller to reject.
 */
function resolveJoinTargets(
  verdict: MongoGuardVerdict,
  catalog: SchemaCatalog,
): { pipelineJson: string; unresolved: string[] } {
  const unresolved = verdict.collections.filter((c) => resolveCollection(c, catalog) === null);
  if (unresolved.length > 0 || verdict.collections.length === 0) {
    return { pipelineJson: verdict.pipelineJson, unresolved };
  }
  const pipeline = parsePipeline(verdict.pipelineJson) ?? [];
  const rewritten = rewriteJoinTargets(pipeline, (n) => resolveCollection(n, catalog));
  return { pipelineJson: JSON.stringify(rewritten), unresolved };
}

export function createMongoAskSql(config: MongoAskConfig): MongoAskEngine {
  const policy: MongoGuardPolicy = { ...DEFAULT_MONGO_GUARD_POLICY, ...config.policy };

  let cached: { catalog: SchemaCatalog; at: number; ttl: number } | null = null;
  let inflight: Promise<SchemaCatalog> | null = null;

  const catalog = async (): Promise<SchemaCatalog> => {
    if (cached && Date.now() - cached.at < cached.ttl) return cached.catalog;
    if (inflight) return inflight;
    inflight = (async () => {
      await config.connector.connect();
      const cat = await config.connector.introspect();
      // No readable collections plus warnings is a permission/network failure
      // masquerading as an empty database; surface it and never cache it.
      const allEmpty = cat.tables.length === 0 || cat.tables.every((t) => t.columns.length === 0);
      if (allEmpty && cat.warnings.length > 0) {
        throw new AskSqlError('DB_QUERY_ERROR', {
          userMessage: "Could not read this database's collections. Check the connection's permissions, then try again.",
          detail: `introspection returned no readable collections with warnings: ${cat.warnings.join('; ').slice(0, 500)}`,
          retryable: true,
        });
      }
      const ttl = cat.warnings.length > 0 ? WARNED_CATALOG_TTL_MS : CATALOG_TTL_MS;
      cached = { catalog: cat, at: Date.now(), ttl };
      return cat;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const guard = (pipelineJson: string): MongoGuardVerdict => guardPipeline(pipelineJson, policy);

  const ask = async (question: string, opts: MongoAskOptions = {}): Promise<MongoAskResult> => {
    // Per-ask handler wins so a caller can route progress for this turn.
    const emit = (event: EngineEvent): void => (opts.onEvent ?? config.onEvent)?.(event);
    const q = question.trim();
    if (!q) throw new AskSqlError('INVALID_INPUT', { userMessage: 'Ask a question about your data to get started.' });
    if (q.length > MAX_QUESTION_LENGTH) {
      throw new AskSqlError('INVALID_INPUT', {
        userMessage: 'That question is too long. Keep it under 10,000 characters.',
      });
    }

    emit({ type: 'stage', stage: 'catalog' });
    const fullCatalog = await catalog();
    emit({ type: 'stage', stage: 'prune' });
    let pruned = pruneCatalog(fullCatalog, q, config.pruner);
    if (pruned.dropped > 0)
      emit({ type: 'warning', message: `Schema narrowed to ${pruned.catalog.tables.length} relevant collections.` });

    const system = buildPipelineSystem(policy.maxRows, config.customInstructions);
    let userPrompt = buildPipelineUser({
      question: q,
      schemaText: pruned.schemaText,
      glossary: config.glossary,
      context: opts.context,
    });
    let lastPipeline = '';
    let contextShrunk = false;
    let triedFuzzyRepair = false;

    for (let attempt = 0; ; attempt++) {
      emit({ type: 'stage', stage: attempt === 0 ? 'llm' : 'repair', detail: `attempt ${attempt + 1}` });
      let text: string;
      try {
        const result = await callModel({
          model: config.model,
          system,
          prompt: userPrompt,
          signal: opts.signal,
          settings: config.llm,
          onToken: (t) => emit({ type: 'token', text: t }),
        });
        text = result.text;
      } catch (err) {
        if (err instanceof AskSqlError && err.code === 'LLM_CONTEXT_OVERFLOW' && !contextShrunk) {
          contextShrunk = true;
          const half = Math.max(5, Math.floor(fullCatalog.tables.length / 2));
          pruned = pruneCatalog(fullCatalog, q, {
            maxTables: half,
            maxSchemaTokens: Math.max(1000, Math.floor((config.pruner?.maxSchemaTokens ?? 6000) / 2)),
          });
          userPrompt = buildPipelineUser({
            question: q,
            schemaText: pruned.schemaText,
            glossary: config.glossary,
            context: opts.context,
          });
          attempt -= 1;
          continue;
        }
        throw err;
      }

      emit({ type: 'stage', stage: 'extract' });
      const extraction = extractPipeline(text);
      if (!extraction) {
        const impossible = extractImpossible(text);
        if (impossible) {
          const near = closestTableName(q, fullCatalog);
          if (near && !triedFuzzyRepair) {
            triedFuzzyRepair = true;
            userPrompt = buildMongoRepairUser({
              question: q,
              failedPipeline: lastPipeline,
              failure: `No collection matches the question exactly, but a "${near}" collection exists. If the question meant that collection, answer using it.`,
              schemaText: pruned.schemaText,
            });
            attempt -= 1;
            continue;
          }
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage: `I wasn't able to build a query for that one: ${impossible}`,
            detail: 'model returned IMPOSSIBLE sentinel',
            retryable: false,
          });
        }
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError(looksLikeRefusal(text) ? 'LLM_REFUSAL' : 'LLM_BAD_OUTPUT', {
            detail: `no pipeline extracted after ${attempt + 1} attempts; raw preview: ${text.slice(0, 200)}`,
          });
        }
        userPrompt = buildMongoRepairUser({
          question: q,
          failedPipeline: lastPipeline,
          failure: 'The response contained no db.<collection>.aggregate([...]) call. Reply with one in a ```js fence.',
          schemaText: pruned.schemaText,
        });
        continue;
      }
      lastPipeline = extraction.pipelineJson;

      emit({ type: 'stage', stage: 'guard' });
      const verdict = guard(extraction.pipelineJson);
      if (!verdict.allowed) {
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError('GUARD_BLOCKED', {
            userMessage: `I didn't run that one for safety: ${verdict.reason ?? 'the generated pipeline is not allowed.'}`,
            detail: `ruleId=${verdict.ruleId ?? 'unknown'} after ${attempt + 1} attempts`,
          });
        }
        userPrompt = buildMongoRepairUser({
          question: q,
          failedPipeline: extraction.pipelineJson,
          failure: `The pipeline validator rejected it: ${verdict.reason ?? verdict.ruleId ?? 'not allowed'}. Produce a single read-only pipeline.`,
          schemaText: pruned.schemaText,
        });
        continue;
      }

      // Collection-existence floor: a wrong-cased name silently returns zero docs.
      const resolved = resolveCollection(extraction.collection, fullCatalog);
      if (!resolved) {
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage: `I couldn't find a collection called "${extraction.collection}" in this database. Try rephrasing, or check the schema.`,
            detail: 'unknown collection after repairs',
            retryable: false,
          });
        }
        userPrompt = buildMongoRepairUser({
          question: q,
          failedPipeline: extraction.pipelineJson,
          failure: `Collection "${extraction.collection}" does not exist in the schema. Use only collections from the <schema> block.`,
          schemaText: pruned.schemaText,
        });
        continue;
      }

      // Join-target floor: a hallucinated/wrong-cased $lookup `from` silently joins
      // nothing. Resolve every referenced collection and rewrite it to real casing.
      const joins = resolveJoinTargets(verdict, fullCatalog);
      if (joins.unresolved.length > 0) {
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage: `I couldn't find a collection called "${joins.unresolved[0]}" referenced by a join. Try rephrasing, or check the schema.`,
            detail: `unknown join collection(s) after repairs: ${joins.unresolved.join(', ')}`,
            retryable: false,
          });
        }
        userPrompt = buildMongoRepairUser({
          question: q,
          failedPipeline: extraction.pipelineJson,
          failure: `A join references collection(s) not in the schema: ${joins.unresolved.join(', ')}. Use only collections from the <schema> block.`,
          schemaText: pruned.schemaText,
        });
        continue;
      }

      emit({ type: 'stage', stage: 'done' });
      const warnings: string[] = [];
      if (verdict.autoLimited)
        warnings.push(`A row limit of ${policy.maxRows} was added automatically - export to get everything.`);
      if (verdict.loweredLimit) warnings.push(`The row limit was lowered to ${policy.maxRows}.`);
      return {
        pipelineJson: joins.pipelineJson,
        collection: resolved,
        explanation: extraction.explanation,
        autoLimited: verdict.autoLimited,
        loweredLimit: verdict.loweredLimit,
        warnings,
        repairs: attempt,
      };
    }
  };

  const execute = async (pipelineJson: string, collection: string, opts: ExecuteOptions = {}): Promise<ResultSet> => {
    // Re-guard every time: the pipeline may have been edited, and Mongo has no
    // read-only session, so the guard is the sole safety floor.
    const verdict = guard(pipelineJson);
    if (!verdict.allowed) {
      throw new AskSqlError('GUARD_BLOCKED', {
        userMessage: `I didn't run that one for safety: ${verdict.reason ?? 'the pipeline is not allowed.'}`,
        detail: `ruleId=${verdict.ruleId ?? 'unknown'}`,
      });
    }
    const fullCatalog = await catalog();
    const resolved = resolveCollection(collection, fullCatalog);
    if (!resolved) {
      throw new AskSqlError('DB_QUERY_ERROR', {
        userMessage: `There is no collection called "${collection}" in this database.`,
        detail: 'unknown collection at execute',
      });
    }
    // Reject/repair-case join targets too: a wrong-cased $lookup silently joins nothing.
    const joins = resolveJoinTargets(verdict, fullCatalog);
    if (joins.unresolved.length > 0) {
      throw new AskSqlError('DB_QUERY_ERROR', {
        userMessage: `A join references a collection called "${joins.unresolved[0]}" that does not exist in this database.`,
        detail: `unknown join collection(s) at execute: ${joins.unresolved.join(', ')}`,
      });
    }
    const pipeline = parsePipeline(joins.pipelineJson) ?? [];
    await config.connector.connect();
    return config.connector.aggregate(resolved, pipeline, opts);
  };

  const explain = async (pipelineJson: string, opts: { signal?: AbortSignal } = {}): Promise<string> => {
    // Guard first so this cannot be used as a free LLM text channel.
    const verdict = guard(pipelineJson);
    if (!verdict.allowed) {
      throw new AskSqlError('GUARD_BLOCKED', {
        userMessage: `I can't explain that one: ${verdict.reason ?? 'it is not a read-only pipeline.'}`,
        detail: `ruleId=${verdict.ruleId ?? 'unknown'}`,
      });
    }
    const result = await callModel({
      model: config.model,
      system: buildMongoExplainSystem(),
      prompt: buildMongoExplainUser(verdict.pipelineJson),
      signal: opts.signal,
      settings: config.llm,
    });
    return result.text.trim();
  };

  return {
    ask,
    execute,
    explain,
    catalog,
    invalidateCatalog: () => {
      cached = null;
    },
  };
}
