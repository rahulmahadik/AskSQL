/**
 * The MongoDB engine path: a non-SQL parallel to the SQL EnginePipeline. A question becomes a
 * single read-only aggregation pipeline through the same ask -> extract -> guard -> (repair) loop.
 * MongoDB has no read-only session, so guardPipeline is re-run on every execute.
 */

import { AskSqlError } from '../errors.js';
import { callModel } from '../llm.js';
import { pruneCatalog } from '../catalog.js';
import {
  closestTableName,
  isDatabaseOverviewQuestion,
  isSchemaAdviceQuestion,
  isSchemaProposalQuestion,
  isWriteRequest,
} from '../schema-match.js';
import {
  capabilityAnswer,
  isCapabilityQuestion,
  isDegenerateAnswer,
  isPromptInjection,
  isOffTopic,
  isProseRefusal,
  looksDatabaseRelated,
  offTopicAnswer,
  stripSentinel,
  type SchemaAnswer,
} from '../scope.js';
import { mentionsCatalogName, SCHEMA_CHANGE_RE, unknownReferencesInProse } from '../grounding.js';
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
  guardPipeline,
  parsePipeline,
  resolveMongoGuardPolicy,
  type MongoGuardPolicy,
  type MongoGuardVerdict,
} from './guard.js';
import { extractImpossible, extractPipeline } from './extract.js';
import {
  buildMongoExplainSystem,
  buildMongoExplainUser,
  buildMongoSchemaAnswerScopeRepairUser,
  buildMongoSchemaAnswerSystem,
  buildMongoSchemaAnswerUser,
  buildMongoRepairUser,
  buildPipelineSystem,
  buildPipelineUser,
  type GlossaryEntry,
  type MongoContextTurn,
} from './prompts.js';

const MAX_REPAIRS = 2;
const CATALOG_TTL_MS = 300_000;
// A catalog carrying warnings (per-collection sample failures) is partial and cached only briefly.
const WARNED_CATALOG_TTL_MS = 30_000;
const MAX_QUESTION_LENGTH = 10_000;

/** A MongoDB data source: results come from a (collection, pipeline) pair, and introspection is sampling-based. */
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
  /** Send sampled field values to the model. Off by default: only the schema leaves the machine. */
  readonly allowDataInPrompt?: boolean;
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
  /** Prose answer about the database itself, for a question no pipeline can answer. Mirrors the SQL engine's method. */
  explainSchema(
    question: string,
    opts?: { signal?: AbortSignal; context?: readonly MongoContextTurn[] },
  ): Promise<SchemaAnswer>;
  catalog(): Promise<SchemaCatalog>;
  invalidateCatalog(): void;
}

/** A question asking to add/change/remove data or collections; word-for-word the SQL path's list. */
const MONGO_SCHEMA_CHANGE_RE = SCHEMA_CHANGE_RE;

/** A write command offered in an answer: the document counterpart of PROPOSED_WRITE_RE. */
const MONGO_WRITE_COMMAND_RE =
  /\bdb\.\w+\.(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|createIndex|dropIndex|drop|renameCollection)\s*\(/i;

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
 * Resolve every $lookup/$graphLookup/$unionWith target against the catalog and rewrite it to real
 * casing; an unresolved name is reported, since a wrong-cased target silently joins nothing.
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

/** Stages that only slice a result; a pipeline made solely of these answers nothing. */
const PASSTHROUGH_STAGES: ReadonlySet<string> = new Set(['$limit', '$skip', '$sort', '$sample']);

/** The model saying in prose that it cannot answer while still emitting a pipeline. */
const CANNOT_ANSWER_RE =
  /\b(?:impossible to answer|impossible to determine|cannot be answered|can(?:no|')t be answered|not possible to answer|unable to answer|no way to answer|(?:does not|doesn't|do not|don't) (?:contain|have) (?:any |the )?(?:information|data|fields?|columns?)[^.?!]{0,30}(?:needed|required|necessary) to answer|(?:cannot|can(?:no|')t) (?:be )?(?:determine|determined|answer)[^.?!]{0,40}\bfrom (?:this|the) schema)\b/i;

/** True when a pipeline selects, groups and computes nothing - it just hands back arbitrary documents. */
function isNoOpPipeline(pipelineJson: string): boolean {
  let stages: unknown;
  try {
    stages = JSON.parse(pipelineJson);
  } catch {
    return false; // unparsable is the guard's problem, not this check's
  }
  if (!Array.isArray(stages)) return false;
  // `[]` selects nothing; the guard auto-limits it into 1000 arbitrary documents.
  if (stages.length === 0) return true;
  return stages.every((stage) => {
    if (typeof stage !== 'object' || stage === null) return false;
    const keys = Object.keys(stage as Record<string, unknown>);
    return keys.length > 0 && keys.every((k) => PASSTHROUGH_STAGES.has(k));
  });
}

export function createMongoAskSql(config: MongoAskConfig): MongoAskEngine {
  // The prompt, the guard and the warning text all name one row cap.
  const policy: MongoGuardPolicy = resolveMongoGuardPolicy(config.policy);

  let cached: { catalog: SchemaCatalog; at: number; ttl: number } | null = null;
  let inflight: Promise<SchemaCatalog> | null = null;
  // Bumped by invalidateCatalog so an introspect already running cannot write a stale result.
  let generation = 0;

  /**
   * Drops sampled field values unless the user opted in. Applied at the single exit from
   * `catalog`, so no caller can leak values by forgetting to strip them.
   */
  const withoutSampledData = (cat: SchemaCatalog): SchemaCatalog => {
    if (config.allowDataInPrompt === true) return cat;
    if (!cat.tables.some((t) => t.columns.some((c) => c.sampledValues && c.sampledValues.length > 0))) return cat;
    return {
      ...cat,
      tables: cat.tables.map((t) => ({
        ...t,
        columns: t.columns.map(({ sampledValues: _dropped, ...rest }) => rest),
      })),
    };
  };

  const catalog = async (): Promise<SchemaCatalog> => {
    if (cached && Date.now() - cached.at < cached.ttl) return withoutSampledData(cached.catalog);
    if (inflight) return inflight.then(withoutSampledData);
    const startedAt = generation;
    inflight = (async () => {
      await config.connector.connect();
      const cat = await config.connector.introspect();
      // No readable collections plus warnings is a permission/network failure, not an empty database.
      const allEmpty = cat.tables.length === 0 || cat.tables.every((t) => t.columns.length === 0);
      if (allEmpty && cat.warnings.length > 0) {
        throw new AskSqlError('DB_QUERY_ERROR', {
          userMessage:
            "Could not read this database's collections. Check the connection's permissions, then try again.",
          detail: `introspection returned no readable collections with warnings: ${cat.warnings.join('; ').slice(0, 500)}`,
          retryable: true,
        });
      }
      const ttl = cat.warnings.length > 0 ? WARNED_CATALOG_TTL_MS : CATALOG_TTL_MS;
      // Only the newest read may cache: an invalidate during this introspect starts a new one.
      if (startedAt === generation) cached = { catalog: cat, at: Date.now(), ttl };
      return withoutSampledData(cat);
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

    // Same routing the SQL engine does, write checked first; answered from the prose path.
    if (isCapabilityQuestion(q)) {
      throw new AskSqlError('LLM_BAD_OUTPUT', {
        userMessage: 'That is a question about AskSQL itself rather than the data.',
        detail: 'capability question routed to the prose path',
        retryable: false,
      });
    }
    // Declined before any model call: a small model can be argued into answering these.
    if (isPromptInjection(q)) {
      throw new AskSqlError('LLM_REFUSAL', {
        userMessage: 'I only answer questions about the data in this database.',
        detail: 'prompt-injection attempt declined',
        retryable: false,
      });
    }
    if (isWriteRequest(q)) {
      throw new AskSqlError('LLM_BAD_OUTPUT', {
        userMessage:
          'That asks for a statement that changes data. AskSQL is read-only, so it is written out for you to run yourself.',
        detail: 'write request routed to the proposal path',
        retryable: false,
      });
    }
    if (isSchemaAdviceQuestion(q) || isDatabaseOverviewQuestion(q)) {
      throw new AskSqlError('LLM_BAD_OUTPUT', {
        userMessage: 'That asks about the schema itself rather than the data in it, so there is no query to run.',
        detail: 'schema-advice question routed to the prose path',
        retryable: false,
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
    // Same as the SQL engine: a model that says nothing on every attempt is unreachable.
    let everyReplyEmpty = true;
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

      if (text.trim().length > 0) everyReplyEmpty = false;

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
          if (everyReplyEmpty) {
            throw new AskSqlError('LLM_UNAVAILABLE', {
              userMessage:
                'The AI model returned an empty response. Check the model name is right and that your account can use it.',
              detail: `model returned nothing on all ${attempt + 1} attempts`,
            });
          }
          throw new AskSqlError(looksLikeRefusal(text) ? 'LLM_REFUSAL' : 'LLM_BAD_OUTPUT', {
            // The default message says "SQL", which is the wrong word on a MongoDB connection.
            userMessage: "Couldn't produce a valid aggregation pipeline for this question. Try rephrasing it.",
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

      // The document counterpart of the SQL path's literal-answer check.
      if (isNoOpPipeline(extraction.pipelineJson) && CANNOT_ANSWER_RE.test(text)) {
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage: "That question doesn't seem to match any collection in this database.",
            detail: 'pipeline selects nothing (no $match/$group/$project stage)',
            retryable: false,
          });
        }
        userPrompt = buildMongoRepairUser({
          question: q,
          failedPipeline: extraction.pipelineJson,
          failure:
            'That pipeline has no stage that answers the question. Use $match/$group/$project, or reply with IMPOSSIBLE and one sentence saying why.',
          schemaText: pruned.schemaText,
        });
        continue;
      }

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

      // Join-target floor: a hallucinated or wrong-cased $lookup `from` silently joins nothing.
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
    // Re-guard every time: the pipeline may have been edited, and Mongo has no read-only session.
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

  const explainSchema = async (
    question: string,
    opts: { signal?: AbortSignal; context?: readonly MongoContextTurn[] } = {},
  ): Promise<SchemaAnswer> => {
    const q = (question ?? '').trim();
    if (!q) throw new AskSqlError('INVALID_INPUT');
    // Same cap as every other entry point: this one is reachable from the public server route.
    if (q.length > MAX_QUESTION_LENGTH) {
      throw new AskSqlError('INVALID_INPUT', {
        userMessage: 'The question is too long. Keep it under 10,000 characters.',
        detail: `question length ${q.length}`,
      });
    }
    // Answered in code: a model could get "can you delete my data" wrong in the direction that matters.
    if (isPromptInjection(q)) return offTopicAnswer('MongoDB');
    if (isCapabilityQuestion(q)) return capabilityAnswer('MongoDB');
    const full = await catalog();
    if (full.tables.length === 0) {
      return {
        answer: 'This connection has no collections the current user can read.',
        tables: [],
        grounded: true,
        unknownReferences: [],
        isSchemaChange: false,
      };
    }
    // Same rule as the SQL engine: advice proposes names, an overview does not.
    const isSchemaChange = MONGO_SCHEMA_CHANGE_RE.test(q) || isSchemaProposalQuestion(q);
    const pruned = pruneCatalog(full, q, config.pruner);
    let answer = (
      await callModel({
        model: config.model,
        system: buildMongoSchemaAnswerSystem(isSchemaChange),
        prompt: buildMongoSchemaAnswerUser(q, pruned.schemaText, opts.context),
        signal: opts.signal,
        settings: config.llm,
      })
    ).text.trim();
    // Same signals as the SQL path: database words, a change request, a real collection name, or a follow-up.
    const questionIsAboutThisDatabase =
      looksDatabaseRelated(q) ||
      isSchemaChange ||
      mentionsCatalogName(q, full) ||
      (Array.isArray(opts.context) &&
        opts.context.some((t) => typeof t?.pipelineJson === 'string' && t.pipelineJson.trim().length > 0));
    if (isOffTopic(answer) || (isDegenerateAnswer(answer) && !MONGO_WRITE_COMMAND_RE.test(answer))) {
      // Challenge the refusal once when the question is plainly about data; accept it otherwise.
      if (!questionIsAboutThisDatabase) return offTopicAnswer('MongoDB');
      answer = (
        await callModel({
          model: config.model,
          // No sentinel in this system prompt: the question is already known to be about data.
          system: buildMongoSchemaAnswerSystem(isSchemaChange, false),
          prompt: buildMongoSchemaAnswerScopeRepairUser(q, pruned.schemaText),
          signal: opts.signal,
          settings: config.llm,
        })
      ).text.trim();
      // Same as the SQL path: after the retry a refusal arrives as prose, not the sentinel.
      if (
        isOffTopic(answer) ||
        (isDegenerateAnswer(answer) && !MONGO_WRITE_COMMAND_RE.test(answer)) ||
        isProseRefusal(answer, mentionsCatalogName(answer, full))
      ) {
        return offTopicAnswer('MongoDB');
      }
    }
    // Same deterministic backstop as the SQL path, for models too small to follow the rule.
    if (
      !questionIsAboutThisDatabase &&
      !mentionsCatalogName(answer, full) &&
      !looksDatabaseRelated(answer) &&
      !MONGO_WRITE_COMMAND_RE.test(answer)
    ) {
      return offTopicAnswer('MongoDB');
    }
    // Strip before grounding, for the same reason as the SQL path.
    answer = stripSentinel(answer);
    // A proposed write always says who runs it; a write in the QUESTION counts too.
    const withNote =
      (MONGO_WRITE_COMMAND_RE.test(answer) || MONGO_WRITE_COMMAND_RE.test(q)) && !/read-only/i.test(answer)
        ? `${answer}\n\n*Proposal only - AskSQL is read-only and never executes commands; run it yourself if you want it applied.*`
        : answer;
    // Grounded against the FULL catalog, so a pruned-away collection is not read as an invention.
    // For a change request these are proposed names, not errors.
    const unknownReferences = unknownReferencesInProse(withNote, full, { documentStyle: true });
    // The pipeline a prose answer suggested, so a follow-up can refer to it. Read-only only, and
    // only when it names collections and fields that exist.
    const proposed = extractPipeline(withNote)?.pipelineJson?.trim();
    const proposedSql =
      proposed &&
      guard(proposed).allowed &&
      unknownReferencesInProse(proposed, full, { documentStyle: true }).length === 0
        ? proposed
        : undefined;
    return {
      answer: withNote,
      tables: pruned.catalog.tables.map((t) => t.name),
      grounded: unknownReferences.length === 0,
      unknownReferences,
      isSchemaChange,
      ...(proposedSql ? { proposedSql } : {}),
    };
  };

  return {
    ask,
    execute,
    explain,
    explainSchema,
    catalog,
    invalidateCatalog: () => {
      // Bump the generation too: an introspect already running must not write its result back.
      generation += 1;
      inflight = null;
      cached = null;
    },
  };
}
