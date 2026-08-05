/**
 * The AskSQL engine: one pipeline for every surface.
 * question -> catalog -> prune -> prompt -> LLM (streamed) -> extract -> GUARD -> repair loop
 * (≤2) -> approval (caller's job) -> execute -> typed ResultSet.
 * The guard runs on every SQL string before execution; no DB session is held open across an LLM call.
 */

import { joinGraph, pruneCatalog } from './catalog.js';
import { AskSqlError } from './errors.js';
import { extractImpossible, extractSql } from './extract.js';
import { guardSql, resolveGuardPolicy } from './guard.js';
import { fanOutAggregate, ungroupedAggregate } from './semantics.js';
import { historyId, MemoryHistoryStore } from './history.js';
import { callModel } from './llm.js';
import {
  buildExplainSystem,
  buildExplainUser,
  buildRepairUser,
  buildSchemaAnswerRepairUser,
  buildSchemaAnswerScopeRepairUser,
  buildSchemaAnswerSystem,
  buildSchemaAnswerUser,
  buildSqlSystem,
  buildSqlUser,
  OFF_TOPIC_SENTINEL,
} from './prompt.js';
import {
  catalogQueryHint,
  closestTableName,
  isDatabaseOverviewQuestion,
  isMetadataQuestion,
  isSchemaAdviceQuestion,
  isRerunPreviousRequest,
  isSchemaProposalQuestion,
  isWriteRequest,
} from './schema-match.js';
import { mentionsCatalogName, SCHEMA_CHANGE_RE, unknownReferencesInProse } from './grounding.js';
export { unknownReferencesInProse } from './grounding.js';
import {
  capabilityAnswer,
  isCapabilityQuestion,
  isDegenerateAnswer,
  isPromptInjection,
  isOffTopic,
  isProseRefusal,
  stripSentinel,
  looksDatabaseRelated,
  MODEL_REFUSAL_RE,
  offTopicAnswer,
  type SchemaAnswer,
} from './scope.js';
export {
  capabilityAnswer,
  isCapabilityQuestion,
  isDegenerateAnswer,
  isOffTopic,
  isProseRefusal,
  looksDatabaseRelated,
  offTopicAnswer,
} from './scope.js';
import type {
  AskOptions,
  AskResult,
  AskSqlConfig,
  Connector,
  EngineEvent,
  ExecuteOptions,
  GuardPolicy,
  HistoryStore,
  LlmUsage,
  ResultSet,
  SchemaCatalog,
} from './types.js';

/**
 * A driver error can quote the offending row ("Key (email)=(ada@example.com) already exists").
 * The user never asked to send that, so the value is redacted before the text reaches a prompt.
 * The structural part - constraint, column, table, error code - is what the repair needs.
 */
export function redactValuesInError(detail: string): string {
  return (
    detail
      .replace(/(\((?:[^()]*)\)\s*=\s*)\([^)]*\)/g, '$1(...)') // Key (email)=(ada@...) already exists
      // MySQL and SQLite quote IDENTIFIERS this way too, and the repair loop needs the name to fix
      // a wrong column, so those phrasings keep theirs.
      .replace(/'[^']*'/g, (match, offset: number, whole: string) =>
        /\b(unknown column|unknown table|no such column|no such table|column|table|field|near|constraint|index)\s*$/i.test(
          whole.slice(Math.max(0, offset - 40), offset),
        )
          ? match
          : "'...'",
      )
      // Phrasings where the quoted text is a VALUE, not an identifier. A blanket rule would strip
      // the column and table names the repair loop needs.
      .replace(/(invalid input syntax for type \w+:\s*)"[^"]*"/gi, '$1"..."')
      .replace(/(out of range for type \w+:\s*)"[^"]*"/gi, '$1"..."')
      .replace(/(invalid value\s*(?:for \w+)?:\s*)"[^"]*"/gi, '$1"..."')
      .replace(/(unable to parse|could not convert|conversion failed for)([^"]{0,40})"[^"]*"/gi, '$1$2"..."')
      .replace(/"[^"]{60,}"/g, '"..."')
  ); // nothing names an identifier this long
}

const MAX_REPAIRS = 2;
/** "SELECT 'canned reply' AS x" with no FROM: a model faking conversation as data. */
const LITERAL_STRING_ANSWER_RE = /^select\s+'(?:[^']|'')*'\s*(?:as\s+\w+)?\s*(?:limit\s+\d+)?\s*;?\s*$/i;
const CATALOG_TTL_MS = 300_000;
// A partially-failed introspection (warnings present) is cached only briefly.
const WARNED_CATALOG_TTL_MS = 30_000;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
/** A question longer than this is almost certainly not a question; reject it before the LLM call. */
const MAX_QUESTION_LENGTH = 10_000;

/** A follow-up is only a follow-up if a prior turn actually carries a query. */
function hasUsableContext(context?: readonly { question: string; sql: string }[]): boolean {
  return Array.isArray(context) && context.some((t) => typeof t?.sql === 'string' && t.sql.trim().length > 0);
}

export interface ExecuteEngineOptions extends ExecuteOptions {
  readonly connectionId?: string;
  /** Recorded into history alongside the SQL. */
  readonly question?: string;
  /** Owning user, recorded on the history row (server mode). */
  readonly userId?: string;
}

export interface ExplainOptions {
  readonly connectionId?: string;
  readonly signal?: AbortSignal;
}

export interface ExplainSchemaOptions {
  readonly connectionId?: string;
  readonly signal?: AbortSignal;
  /** Prior turns, so a follow-up like "explain this query" knows which query. */
  readonly context?: readonly { question: string; sql: string }[];
}

export type { SchemaAnswer } from './scope.js';

/**
 * Returns the first base relation referenced by the SQL that is missing from the catalog, or null.
 * CTE names count as known; pass `GuardVerdict.tables` to avoid a second parse of the statement.
 */
// Standard read-only system catalogs; tables in these schemas are never treated as unknown.
const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  'information_schema',
  'pg_catalog',
  'mysql',
  'performance_schema',
  'sys',
]);

export function firstUnknownTable(
  sql: string,
  catalog: SchemaCatalog,
  grammar: string,
  precomputed?: readonly string[],
): string | null {
  let list: readonly string[];
  if (precomputed) {
    list = precomputed;
  } else {
    try {
      list = tableParser.tableList(sql, { database: grammar });
    } catch {
      return null; // the guard already parsed it; never double-block here
    }
  }
  const known = new Set<string>();
  for (const t of catalog.tables) {
    known.add(t.name.toLowerCase());
    if (t.schema) known.add(`${t.schema.toLowerCase()}.${t.name.toLowerCase()}`);
  }
  // CTE names (WITH x AS ...) count as known relations.
  const cteNames = collectCteNames(sql);
  for (const entry of list) {
    const parts = entry.split('::');
    const schema = parts[1] && parts[1] !== 'null' ? parts[1].toLowerCase() : null;
    const name = (parts[2] ?? '').toLowerCase();
    if (!name) continue;
    if (cteNames.has(name)) continue;
    const qualified = schema ? `${schema}.${name}` : name;
    if (known.has(qualified) || known.has(name)) continue;
    // System catalogs are real relations, not hallucinated tables.
    if (schema && SYSTEM_SCHEMAS.has(schema)) continue;
    if (name.startsWith('sqlite_') || name.startsWith('pg_')) continue;
    return schema ? `${schema}.${name}` : name;
  }
  return null;
}

/** A write statement offered in an answer, fenced or bare; matched by statement shape, anchored to a line start. */
const PROPOSED_WRITE_RE =
  /^\s*(?:```\w*\s*)?(insert\s+into\s|update\s+[\w."`]+(?:\s+(?:as\s+)?[\w"`]+)?\s+set\s|delete\s+(?:from\s|[\w."`]+\s+from\s)|merge\s+into\s|replace\s+into\s|upsert\s+into\s|alter\s+(?:table|schema|view|index|sequence|database)\s|create\s+(?:or\s+replace\s+)?(?:table|index|unique\s+index|view|materialized\s+view|schema|trigger|function|procedure|sequence|database|role|user|type|extension|domain|policy)\s|drop\s+(?:table|index|view|materialized\s+view|schema|trigger|function|procedure|sequence|database|role|user|type|extension|domain|policy)\s|comment\s+on\s+(?:table|column)\s|truncate\s+(?:table\s+)?[\w."`]+\s*;|grant\s+[\w,]+(?:[ \t]+[\w,]+)*\s+on\s+[\w."`]+\s+to\s|revoke\s+[\w,]+(?:[ \t]+[\w,]+)*\s+on\s+[\w."`]+\s+from\s)/imu;

/** The same statement shapes, unanchored; used only on the QUESTION, where a pasted write is the point. */
const WRITE_IN_QUESTION_RE =
  /(insert\s+into\s|update\s+[\w."`]+(?:\s+(?:as\s+)?[\w"`]+)?\s+set\s|delete\s+(?:from\s|[\w."`]+\s+from\s)|merge\s+into\s|replace\s+into\s|upsert\s+into\s|alter\s+(?:table|schema|view|index|sequence|database)\s|create\s+(?:or\s+replace\s+)?(?:table|index|unique\s+index|view|materialized\s+view|schema|trigger|function|procedure|sequence|database|role|user|type|extension|domain|policy)\s|drop\s+(?:table|index|view|materialized\s+view|schema|trigger|function|procedure|sequence|database|role|user|type|extension|domain|policy)\s|comment\s+on\s+(?:table|column)\s|truncate\s+(?:table\s+)?[\w."`]+\s*;|grant\s+[\w,]+(?:[ \t]+[\w,]+)*\s+on\s+[\w."`]+\s+to\s|revoke\s+[\w,]+(?:[ \t]+[\w,]+)*\s+on\s+[\w."`]+\s+from\s)/imu;

/** Bounds for the whole-schema answer: past these the prompt stops being an overview and starts being the schema. */
const BROAD_MAX_TABLES = 120;
const BROAD_MAX_EDGES = 200;

/** A whole-schema question (relationships, overview, table count) that needs the full picture, not a term-pruned handful of tables. */
const BROAD_SCHEMA_RE =
  /\b(?:relat|overview|summar|structur|entit|connect|erd|diagram)\w*|how many tables?|all (?:the )?tables?|whole (?:schema|database)|about (?:this|the|my) (?:database|schema|db)|what.{0,20}(?:database|schema|db) (?:is|for|about|do)/iu;

export interface CatalogOptions {
  readonly refresh?: boolean;
}

export interface AskSqlEngine {
  readonly policy: GuardPolicy;
  readonly history: HistoryStore;
  connectors: readonly Pick<Connector, 'id' | 'name' | 'engine' | 'database' | 'capabilities'>[];
  catalog(connectionId?: string, opts?: CatalogOptions): Promise<SchemaCatalog>;
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
  execute(sql: string, opts?: ExecuteEngineOptions): Promise<ResultSet>;
  explain(sql: string, opts?: ExplainOptions): Promise<string>;
  /**
   * Answer a natural-language question about the schema in prose, grounded in the catalog.
   * Explains structure only, never data values. `grounded` is false if the answer named
   * identifiers absent from the schema.
   */
  explainSchema(question: string, opts?: ExplainSchemaOptions): Promise<SchemaAnswer>;
  /**
   * Given a SQL statement the database rejected, ask the model for a corrected one.
   * Returns the guarded corrected SQL, or null. Never runs the query.
   */
  suggestFix(failedSql: string, opts?: SuggestFixOptions): Promise<string | null>;
  /** Record an approved question->SQL pair for the few-shot loop; a no-op without a fewShots store. */
  recordFeedback(question: string, sql: string, opts?: { connectionId?: string; userId?: string }): Promise<void>;
  close(): Promise<void>;
}

interface DbErrorWithSuggestion extends AskSqlError {
  suggestedSql?: string;
}

export interface SuggestFixOptions {
  readonly connectionId?: string;
  /** The original natural-language question - required to repair meaningfully. */
  readonly question?: string;
  /** The database's error detail, fed to the model as the failure reason. */
  readonly errorDetail?: string;
  readonly signal?: AbortSignal;
}

export function createAskSql(config: AskSqlConfig): AskSqlEngine {
  if (!config || !Array.isArray(config.connectors) || config.connectors.length === 0) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'AskSqlConfig.connectors() must contain at least one connector',
      userMessage: 'AskSQL is misconfigured: no database connections are defined.',
    });
  }
  if (!config.model) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'AskSqlConfig.model is required',
      userMessage: 'AskSQL is misconfigured: no AI model is defined.',
    });
  }
  const ids = new Set<string>();
  for (const c of config.connectors) {
    // An empty id makes every lookup ambiguous; an empty name shows a blank entry in every picker.
    if (typeof c.id !== 'string' || c.id.trim() === '') {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: 'a connector has an empty id',
        userMessage: 'AskSQL is misconfigured: a database connection is missing an id.',
      });
    }
    if (typeof c.name !== 'string' || c.name.trim() === '') {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `connector "${c.id}" has an empty name`,
        userMessage: 'AskSQL is misconfigured: a database connection is missing a name.',
      });
    }
    if (ids.has(c.id)) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `duplicate connector id: ${c.id}`,
        userMessage: 'AskSQL is misconfigured: two connections share the same id.',
      });
    }
    ids.add(c.id);
  }

  const policy = resolveGuardPolicy(config.policy);
  const history = config.history ?? new MemoryHistoryStore();
  const catalogCache = new Map<string, { catalog: SchemaCatalog; at: number; ttl: number }>();
  const inflight = new Map<string, Promise<SchemaCatalog>>();

  const connectorById = (connectionId?: string): Connector => {
    const conn = connectionId ? config.connectors.find((c) => c.id === connectionId) : config.connectors[0];
    if (!conn) {
      throw new AskSqlError('INVALID_INPUT', {
        detail: `unknown connectionId: ${connectionId ?? '(none)'}`,
        userMessage: 'Unknown database connection.',
      });
    }
    return conn;
  };

  const emit = (event: EngineEvent, opts?: AskOptions): void => {
    try {
      config.onEvent?.(event);
      opts?.onEvent?.(event);
    } catch {
      // Listener bugs must never break the pipeline.
    }
  };

  const connected = new Set<string>();
  const connecting = new Map<string, Promise<void>>();
  const ensureConnected = async (conn: Connector): Promise<void> => {
    if (connected.has(conn.id)) return;
    // Share one in-flight connect so concurrent first-operations don't each build (and orphan) a pool.
    let pending = connecting.get(conn.id);
    if (!pending) {
      pending = (async () => {
        try {
          await conn.connect();
          connected.add(conn.id);
        } catch (err) {
          // Any connector failing to connect surfaces as a retryable DB_UNREACHABLE.
          throw AskSqlError.from(err, 'DB_UNREACHABLE');
        } finally {
          connecting.delete(conn.id);
        }
      })();
      connecting.set(conn.id, pending);
    }
    return pending;
  };

  /** Enforces `allowDataInPrompt`: drops sampled cell values, keeps declared enum labels. */
  function stripSampledValues(catalog: SchemaCatalog, allowed: boolean): SchemaCatalog {
    if (allowed) return catalog;
    if (!catalog.tables.some((t) => t.columns.some((c) => c.sampledValues && c.sampledValues.length > 0))) {
      return catalog;
    }
    return {
      ...catalog,
      tables: catalog.tables.map((t) => ({
        ...t,
        columns: t.columns.map(({ sampledValues: _dropped, ...rest }) => rest),
      })),
    };
  }

  const catalogGeneration = new Map<string, number>();

  const getCatalog = async (conn: Connector, refresh = false): Promise<SchemaCatalog> => {
    await ensureConnected(conn);
    const cached = catalogCache.get(conn.id);
    if (!refresh && cached && Date.now() - cached.at < cached.ttl) return cached.catalog;
    const running = inflight.get(conn.id);
    if (!refresh && running) return running;
    // A refresh starts a new generation; older reads may still return, but may not cache.
    const generation = refresh ? (catalogGeneration.get(conn.id) ?? 0) + 1 : (catalogGeneration.get(conn.id) ?? 0);
    if (refresh) catalogGeneration.set(conn.id, generation);
    // eslint-disable-next-line prefer-const -- referenced in the async body's finally, so it must be hoisted.
    let p!: Promise<SchemaCatalog>;
    p = (async () => {
      try {
        const catalog = stripSampledValues(await conn.introspect(), config.allowDataInPrompt === true);
        // An empty table set with warnings is a permission/network failure, not an empty database.
        if (catalog.tables.length === 0 && catalog.warnings.length > 0) {
          throw new AskSqlError('DB_QUERY_ERROR', {
            userMessage: "Could not read this database's schema. Check the connection's permissions, then try again.",
            detail: `introspection returned no tables with warnings: ${catalog.warnings.join('; ').slice(0, 500)}`,
            retryable: true,
          });
        }
        const ttl = catalog.warnings.length > 0 ? WARNED_CATALOG_TTL_MS : CATALOG_TTL_MS;
        // Only the newest read may write the cache. A read that started before a refresh can
        // finish after it, and would otherwise reinstate the pre-refresh schema.
        if ((catalogGeneration.get(conn.id) ?? 0) === generation) {
          catalogCache.set(conn.id, { catalog, at: Date.now(), ttl });
        }
        return catalog;
      } finally {
        // Delete by identity so a concurrent refresh=true that replaced this entry isn't orphaned.
        if (inflight.get(conn.id) === p) inflight.delete(conn.id);
      }
    })();
    inflight.set(conn.id, p);
    return p;
  };

  const executeGuarded = async (sql: string, conn: Connector, opts: ExecuteEngineOptions): Promise<ResultSet> => {
    await ensureConnected(conn);
    const verdict = guardSql({ sql, dialect: conn.dialect, policy });
    if (!verdict.allowed) {
      await history.add({
        id: historyId(),
        at: new Date().toISOString(),
        connectionId: conn.id,
        userId: opts.userId,
        question: opts.question,
        sql,
        status: 'blocked',
        errorCode: verdict.ruleId,
      });
      throw new AskSqlError('GUARD_BLOCKED', {
        userMessage: `Blocked for safety: ${verdict.reason ?? 'this statement is not allowed.'}`,
        detail: `ruleId=${verdict.ruleId ?? 'unknown'} sql=${sql.slice(0, 300)}`,
      });
    }
    const started = Date.now();
    try {
      // Clamp maxRows to the policy ceiling; fetch-style dialects (Oracle) get no injected LIMIT.
      const cappedMax = Math.min(opts.maxRows ?? policy.maxRows, policy.maxRows);
      const result = await conn.execute(verdict.sql, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
        maxRows: cappedMax,
      });
      await history.add({
        id: historyId(),
        at: new Date().toISOString(),
        connectionId: conn.id,
        userId: opts.userId,
        question: opts.question,
        sql: verdict.sql,
        status: 'ok',
        durationMs: Date.now() - started,
        rowCount: result.rowCount,
      });
      const warnings = [...result.warnings];
      if (verdict.autoLimited) {
        warnings.push(`A row limit of ${policy.maxRows} was added automatically - these are the first rows only.`);
      }
      if (verdict.loweredLimit) {
        warnings.push(`The row limit was lowered to ${policy.maxRows}.`);
      }
      // An auto-limited result that filled the cap counts as truncated: the injected LIMIT hides the overflow row.
      const truncated = result.truncated || (verdict.autoLimited && result.rowCount >= cappedMax);
      return { ...result, warnings, truncated };
    } catch (err) {
      const mapped = AskSqlError.from(err, 'DB_QUERY_ERROR');
      await history.add({
        id: historyId(),
        at: new Date().toISOString(),
        connectionId: conn.id,
        userId: opts.userId,
        question: opts.question,
        sql: verdict.sql,
        status: 'error',
        errorCode: mapped.code,
        durationMs: Date.now() - started,
      });
      throw mapped;
    }
  };

  const askImpl = async (question: string, opts: AskOptions = {}): Promise<AskResult> => {
    const q = (question ?? '').trim();
    if (!q) throw new AskSqlError('INVALID_INPUT');
    if (q.length > MAX_QUESTION_LENGTH) {
      throw new AskSqlError('INVALID_INPUT', {
        userMessage: 'The question is too long. Keep it under 10,000 characters.',
        detail: `question length ${q.length}`,
      });
    }
    // Routed to the host's prose path before any model call: none of these has an answer in rows.
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
    const conn = connectorById(opts.connectionId);

    emit({ type: 'stage', stage: 'catalog' }, opts);
    const fullCatalog = await getCatalog(conn);

    emit({ type: 'stage', stage: 'prune' }, opts);
    let pruned = pruneCatalog(fullCatalog, q, config.pruner);
    let schemaText = pruned.schemaText;
    if (pruned.dropped > 0) {
      emit({ type: 'warning', message: `Schema narrowed to ${pruned.catalog.tables.length} relevant tables.` }, opts);
    }

    // Few-shot retrieval, scoped to the connection and (in server mode) the requesting user.
    const fewShots = config.fewShots ? await config.fewShots.retrieve(conn.id, q, 4, opts.userId).catch(() => []) : [];

    const system = buildSqlSystem(conn.dialect, policy.maxRows, config.prompts);
    let userPrompt = buildSqlUser({
      question: q,
      schemaText,
      dialect: conn.dialect,
      maxRows: policy.maxRows,
      context: opts.context,
      fewShots,
      glossary: config.glossary,
      rerunPrevious: isRerunPreviousRequest(q),
    });

    const usageTotal: { input: number; output: number } = { input: 0, output: 0 };
    let lastSql = '';
    // A model that says nothing on EVERY attempt is unreachable; one quiet repair round is not.
    let everyReplyEmpty = true;
    let contextShrunk = false;
    let triedMetadataRepair = false;
    let triedFuzzyRepair = false;

    for (let attempt = 0; ; attempt++) {
      emit({ type: 'stage', stage: attempt === 0 ? 'llm' : 'repair', detail: `attempt ${attempt + 1}` }, opts);
      let text: string;
      try {
        const result = await callModel({
          model: config.model,
          system,
          prompt: userPrompt,
          signal: opts.signal,
          settings: config.llm,
          onToken: (t) => emit({ type: 'token', text: t }, opts),
        });
        text = result.text;
        usageTotal.input += result.usage.inputTokens ?? 0;
        usageTotal.output += result.usage.outputTokens ?? 0;
      } catch (err) {
        // on context overflow, shrink the schema once and retry without consuming a repair attempt.
        if (AskSqlError.is(err) && err.code === 'LLM_CONTEXT_OVERFLOW' && !contextShrunk) {
          contextShrunk = true;
          const tighter = pruneCatalog(fullCatalog, q, {
            maxTables: Math.max(5, Math.floor(pruned.catalog.tables.length / 2)),
            maxSchemaTokens: Math.max(1000, Math.floor((config.pruner?.maxSchemaTokens ?? 6000) / 2)),
          });
          pruned = tighter;
          schemaText = tighter.schemaText;
          // On the shrink retry keep the glossary but drop few-shots to reclaim tokens.
          userPrompt = buildSqlUser({
            question: q,
            schemaText,
            dialect: conn.dialect,
            maxRows: policy.maxRows,
            context: opts.context,
            glossary: config.glossary,
          });
          attempt -= 1; // does not consume a repair attempt
          continue;
        }
        throw err;
      }

      if (text.trim().length > 0) everyReplyEmpty = false;

      emit({ type: 'stage', stage: 'extract' }, opts);
      // extractSql runs first: usable SQL wins over an IMPOSSIBLE hedge in the same reply.
      const extraction = extractSql(text);
      if (!extraction) {
        const impossible = extractImpossible(text);
        if (impossible) {
          // A structure question ("show tables") gets one retry pointed at the dialect's catalog listing.
          if (isMetadataQuestion(q) && !triedMetadataRepair) {
            triedMetadataRepair = true;
            userPrompt = buildRepairUser({
              question: q,
              failedSql: lastSql,
              failure: `That question is about database structure. Answer it with a read-only query, using this as a starting point: ${catalogQueryHint(conn.dialect.engine)}`,
              schemaText,
              dialect: conn.dialect,
            });
            attempt -= 1; // a recoverable rephrase, not a wasted repair attempt
            continue;
          }
          // A misspelled table name gets one retry against the closest real name.
          const near = closestTableName(q, fullCatalog);
          if (near && !triedFuzzyRepair) {
            triedFuzzyRepair = true;
            userPrompt = buildRepairUser({
              question: q,
              failedSql: lastSql,
              failure: `There is no exact match, but a "${near}" table exists. If the question meant that table, answer using it.`,
              schemaText,
              dialect: conn.dialect,
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
        const refusal = MODEL_REFUSAL_RE.test(text);
        if (attempt >= MAX_REPAIRS) {
          // Nothing at all on every attempt: the model name is wrong or the account cannot reach it.
          if (everyReplyEmpty) {
            throw new AskSqlError('LLM_UNAVAILABLE', {
              userMessage:
                'The AI model returned an empty response. Check the model name is right and that your account can use it.',
              detail: `model returned nothing on all ${attempt + 1} attempts`,
            });
          }
          throw new AskSqlError(refusal ? 'LLM_REFUSAL' : 'LLM_BAD_OUTPUT', {
            detail: `no SQL extracted after ${attempt + 1} attempts; raw preview: ${text.slice(0, 200)}`,
          });
        }
        userPrompt = buildRepairUser({
          question: q,
          failedSql: lastSql,
          failure: 'The response contained no SQL statement. Reply with one SELECT in a ```sql fence.',
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }
      lastSql = extraction.sql;

      emit({ type: 'stage', stage: 'guard' }, opts);
      const verdict = guardSql({ sql: extraction.sql, dialect: conn.dialect, policy });
      if (!verdict.allowed) {
        if (attempt >= MAX_REPAIRS) {
          await history.add({
            id: historyId(),
            at: new Date().toISOString(),
            connectionId: conn.id,
            userId: opts.userId,
            question: q,
            sql: extraction.sql,
            status: 'blocked',
            errorCode: verdict.ruleId,
          });
          throw new AskSqlError('GUARD_BLOCKED', {
            userMessage: `Blocked for safety: ${verdict.reason ?? 'the generated statement is not allowed.'}`,
            detail: `ruleId=${verdict.ruleId ?? 'unknown'} after ${attempt + 1} attempts`,
          });
        }
        userPrompt = buildRepairUser({
          question: q,
          failedSql: extraction.sql,
          failure: `The SQL validator rejected it: ${verdict.reason ?? verdict.ruleId ?? 'not allowed'}. Produce a single read-only SELECT.`,
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }

      // A SELECT of a hardcoded string touches no table, so the guard allows it; reject the dodge here.
      if (
        (verdict.tables?.length ?? 0) === 0 &&
        (/IMPOSSIBLE/i.test(verdict.sql) || LITERAL_STRING_ANSWER_RE.test(verdict.sql.trim()))
      ) {
        throw new AskSqlError('LLM_BAD_OUTPUT', {
          userMessage: "That question doesn't seem to match any table in this database.",
          detail: 'literal-only SELECT with no table reference',
          retryable: false,
        });
      }

      // Hallucination floor: every base relation must exist in the FULL catalog, using the guard's table list.
      const unknownTable = firstUnknownTable(verdict.sql, fullCatalog, conn.dialect.grammar, verdict.tables);
      if (unknownTable) {
        if (attempt >= MAX_REPAIRS) {
          // Same reasoning as the column case: say what IS there, and name the closest match.
          const names = fullCatalog.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name));
          const closest = closestTableName(unknownTable, fullCatalog);
          const suggestion = closest ? ` Did you mean ${closest}?` : '';
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage:
              `The AI kept referring to a table called "${unknownTable}", which this database does not have, ` +
              `so nothing was run.${suggestion} Available: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}.`,
            detail: `unknown table ${unknownTable} after ${attempt + 1} attempts`,
            retryable: false,
          });
        }
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          failure: `Table "${unknownTable}" does not exist in the schema. Use only tables from the <schema> block.`,
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }

      // Semantic floor: an aggregate beside a bare column with no GROUP BY (rejected by PostgreSQL, wrong in SQLite).
      const needsGrouping = ungroupedAggregate(verdict.sql, conn.dialect.grammar);
      if (needsGrouping && attempt < MAX_REPAIRS) {
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          failure:
            `The query selects "${needsGrouping}" alongside an aggregate but has no GROUP BY, so it does not answer the question. ` +
            `Either group by "${needsGrouping}", or drop it and aggregate over the whole table - whichever the question asks for.`,
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }

      // Semantic floor: a one-to-many join multiplies the rows a SUM sees, so the total is inflated.
      const fanOut = fanOutAggregate(verdict.sql, conn.dialect.grammar, fullCatalog);
      if (fanOut && attempt < MAX_REPAIRS) {
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          failure:
            `The query sums "${fanOut.parent}.${fanOut.column}" while joined to "${fanOut.child}", which has many rows per ` +
            `"${fanOut.parent}" row, so each value is counted once per "${fanOut.child}" row and the total is too high. ` +
            `Aggregate "${fanOut.child}" in a separate subquery or CTE and join the result, or drop the join if the question does not need it.`,
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }

      // Column-level hallucination floor: a column attributed to a real base table must exist on it.
      const unknownColumn = firstUnknownColumn(verdict.sql, fullCatalog, conn.dialect.grammar);
      if (unknownColumn) {
        if (attempt >= MAX_REPAIRS) {
          // Name what exists, so the user can rephrase.
          const columns = unknownColumn.available.slice(0, 12).join(', ');
          const more = unknownColumn.available.length > 12 ? ', ...' : '';
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage:
              `The AI kept using a "${unknownColumn.column}" column on ${unknownColumn.table}, which does not exist, ` +
              `so nothing was run. ${unknownColumn.table} has: ${columns}${more}. ` +
              'Try naming the column you mean - or use a larger model, which is usually the real fix.',
            detail: `unknown column ${unknownColumn.table}.${unknownColumn.column} after ${attempt + 1} attempts`,
            retryable: false,
          });
        }
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          failure: `Column "${unknownColumn.column}" does not exist on table "${unknownColumn.table}". Its real columns are: ${unknownColumn.available.join(', ')}. Use only columns shown in the <schema> block.`,
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }

      emit({ type: 'stage', stage: 'done' }, opts);
      const finalSql = verdict.sql;
      const explanation = extraction.explanation;
      const usage: LlmUsage = { inputTokens: usageTotal.input, outputTokens: usageTotal.output };
      const repairs = attempt;

      return {
        sql: finalSql,
        explanation,
        guard: verdict,
        connectionId: conn.id,
        usage,
        repairs,
        run: async (execOpts?: ExecuteOptions): Promise<ResultSet> => {
          emit({ type: 'stage', stage: 'execute' }, opts);
          try {
            return await executeGuarded(finalSql, conn, { ...execOpts, question: q, userId: opts.userId });
          } catch (err) {
            // on a runtime DB error, attach a corrected query for re-approval rather than running it.
            if (AskSqlError.is(err) && err.code === 'DB_QUERY_ERROR') {
              const suggestion = await tryRepairAfterDbError(err);
              if (suggestion) (err as DbErrorWithSuggestion).suggestedSql = suggestion;
            }
            throw err;
          }
        },
      };

      async function tryRepairAfterDbError(dbErr: AskSqlError): Promise<string | null> {
        try {
          const repairPrompt = buildRepairUser({
            question: q,
            failedSql: finalSql,
            failure: `The database rejected it: ${redactValuesInError(dbErr.detail ?? dbErr.userMessage ?? '')}`,
            schemaText,
            dialect: conn.dialect,
          });
          const repaired = await callModel({
            model: config.model,
            system,
            prompt: repairPrompt,
            signal: opts.signal,
            settings: config.llm,
          });
          const ex = extractSql(repaired.text);
          if (!ex) return null;
          const v = guardSql({ sql: ex.sql, dialect: conn.dialect, policy });
          return v.allowed && v.sql !== finalSql ? v.sql : null;
        } catch {
          return null; // suggestion is best-effort; the original error stands
        }
      }
    }
  };

  return {
    policy,
    history,
    connectors: config.connectors.map((c) => ({
      id: c.id,
      name: c.name,
      engine: c.engine,
      database: c.database,
      capabilities: c.capabilities,
    })),
    catalog: (connectionId, opts) => getCatalog(connectorById(connectionId), opts?.refresh ?? false),
    ask: askImpl,
    execute: (sql, opts = {}) => executeGuarded(sql, connectorById(opts.connectionId), opts),
    explain: async (sql, opts = {}) => {
      const conn = connectorById(opts.connectionId);
      const s = (sql ?? '').trim();
      if (!s) throw new AskSqlError('INVALID_INPUT', { userMessage: 'Provide a SQL statement to explain.' });
      // Guard first: `sql` is caller-supplied, so /explain is not a free text channel to the model.
      const verdict = guardSql({ sql: s, dialect: conn.dialect, policy });
      if (!verdict.allowed) {
        throw new AskSqlError('GUARD_BLOCKED', {
          detail: `explain blocked: ${verdict.reason ?? 'not a read-only statement'}`,
          userMessage: 'Only a read-only SQL query can be explained.',
        });
      }
      const catalog = await getCatalog(conn).catch(() => null);
      const result = await callModel({
        model: config.model,
        system: buildExplainSystem(conn.dialect),
        prompt: buildExplainUser(s, catalog ? pruneCatalog(catalog, s, config.pruner).schemaText : undefined),
        signal: opts.signal,
        settings: config.llm,
      });
      return result.text.trim();
    },
    explainSchema: async (question, opts = {}) => {
      const conn = connectorById(opts.connectionId);
      const q = (question ?? '').trim();
      if (!q) throw new AskSqlError('INVALID_INPUT');
      if (q.length > MAX_QUESTION_LENGTH) {
        throw new AskSqlError('INVALID_INPUT', {
          userMessage: 'The question is too long. Keep it under 10,000 characters.',
          detail: `question length ${q.length}`,
        });
      }
      // Answered in code: a model could get "can you delete my data" wrong in the direction that matters.
      if (isPromptInjection(q)) return offTopicAnswer(conn.dialect.promptLabel);
      if (isCapabilityQuestion(q)) return capabilityAnswer(conn.dialect.promptLabel);
      const catalog = await getCatalog(conn);
      if (catalog.tables.length === 0) {
        return {
          answer: 'This connection has no tables the current user can read.',
          tables: [],
          grounded: true,
          unknownReferences: [],
          isSchemaChange: false,
        };
      }
      // Advice and change requests propose new names; an overview only claims existing structure.
      const isSchemaChange = SCHEMA_CHANGE_RE.test(q) || isSchemaProposalQuestion(q);
      // A whole-schema question gets a compact list of ALL tables plus the full join graph, not term pruning.
      const isBroad = BROAD_SCHEMA_RE.test(q);
      let schemaText: string;
      let relationships: readonly string[];
      let contextTables;
      if (isBroad) {
        // Bounded: listing thousands of tables in full overflows the context window; say what was omitted.
        const listed = catalog.tables.slice(0, BROAD_MAX_TABLES);
        relationships = joinGraph(catalog).slice(0, BROAD_MAX_EDGES);
        const list = listed
          .map(
            (t) =>
              `${t.schema ? `${t.schema}.` : ''}${t.name} (${t.kind}, ${t.columns.length} cols${t.primaryKey.length ? `, pk ${t.primaryKey.join(',')}` : ''})`,
          )
          .join('\n');
        const omitted = catalog.tables.length - listed.length;
        schemaText =
          `This database has exactly ${catalog.tables.length} tables/views.` +
          `${omitted > 0 ? ` The ${listed.length} listed below are a sample; ${omitted} more are not shown, so describe the database in general terms and say the list is partial.` : ' Full list:'}\n${list}`;
        contextTables = listed;
      } else {
        const pruned = pruneCatalog(catalog, q, config.pruner);
        schemaText = pruned.schemaText;
        relationships = joinGraph(pruned.catalog);
        contextTables = pruned.catalog.tables;
      }
      const tables = contextTables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name));
      const system = buildSchemaAnswerSystem(conn.dialect, isSchemaChange);
      let answer = (
        await callModel({
          model: config.model,
          system,
          prompt: buildSchemaAnswerUser(q, schemaText, relationships, opts.context),
          signal: opts.signal,
          settings: config.llm,
        })
      ).text.trim();
      // A real table, view or column name, or a follow-up carrying prior turns, counts as a database question.
      const questionIsAboutThisDatabase =
        looksDatabaseRelated(q) || isSchemaChange || mentionsCatalogName(q, catalog) || hasUsableContext(opts.context);
      if (isOffTopic(answer) || (isDegenerateAnswer(answer) && !PROPOSED_WRITE_RE.test(answer))) {
        // Challenge the refusal once when the question is plainly about data; accept it otherwise.
        if (!questionIsAboutThisDatabase) return offTopicAnswer(conn.dialect.promptLabel);
        answer = (
          await callModel({
            model: config.model,
            // No sentinel in this system prompt: the question is already known to be about data.
            system: buildSchemaAnswerSystem(conn.dialect, isSchemaChange, false),
            prompt: buildSchemaAnswerScopeRepairUser(q, schemaText, conn.dialect.promptLabel, relationships),
            signal: opts.signal,
            settings: config.llm,
          })
        ).text.trim();
        // The retry has no sentinel to emit, so a prose refusal gets the same decline.
        if (
          isOffTopic(answer) ||
          (isDegenerateAnswer(answer) && !PROPOSED_WRITE_RE.test(answer)) ||
          isProseRefusal(answer, mentionsCatalogName(answer, catalog))
        ) {
          return offTopicAnswer(conn.dialect.promptLabel);
        }
      }
      // Deterministic backstop for models too small to follow the sentinel rule.
      if (
        !questionIsAboutThisDatabase &&
        !mentionsCatalogName(answer, catalog) &&
        !looksDatabaseRelated(answer) &&
        !PROPOSED_WRITE_RE.test(answer)
      ) {
        return offTopicAnswer(conn.dialect.promptLabel);
      }
      // Strip before grounding: `out_of_scope` is snake_case and would read as an invented name.
      answer = stripSentinel(answer);
      // Grounding floor, checked against the FULL catalog, so a pruned-away table is not flagged.
      let unknownReferences = unknownReferencesInProse(answer, catalog);
      // One repair pass constrained to real names; skipped for change requests, where new names are the proposal.
      if (unknownReferences.length > 0 && !isSchemaChange) {
        answer = (
          await callModel({
            model: config.model,
            // No sentinel: this pass fixes names, and the raw sentinel must not become the final answer.
            system: buildSchemaAnswerSystem(conn.dialect, isSchemaChange, false),
            prompt: buildSchemaAnswerRepairUser(q, schemaText, unknownReferences, relationships),
            signal: opts.signal,
            settings: config.llm,
          })
        ).text.trim();
        if (isOffTopic(answer)) return offTopicAnswer(conn.dialect.promptLabel);
        unknownReferences = unknownReferencesInProse(answer, catalog);
      }
      // Last, so it survives the repair pass: a write in the answer or the question carries the read-only note.
      if ((PROPOSED_WRITE_RE.test(answer) || WRITE_IN_QUESTION_RE.test(q)) && !/read-only/i.test(answer)) {
        answer +=
          '\n\n*Proposal only - AskSQL is read-only and never executes statements; run it yourself if you want it applied.*';
      }
      // A prose answer often ends in a query the user then asks to run. Carrying it forward is what
      // makes "run that" mean this query rather than a fresh guess; a write is never carried.
      const proposed = extractSql(answer)?.sql?.trim();
      // Read-only is not enough to be worth handing back: a prose answer is not held to the
      // hallucination floor the ask path applies, so the names it used may not exist.
      const proposedSql =
        proposed &&
        guardSql({ sql: proposed, dialect: conn.dialect, policy }).allowed &&
        !firstUnknownTable(proposed, catalog, conn.dialect.grammar) &&
        !firstUnknownColumn(proposed, catalog, conn.dialect.grammar)
          ? proposed
          : undefined;
      return {
        answer,
        tables,
        grounded: unknownReferences.length === 0,
        unknownReferences,
        isSchemaChange,
        ...(proposedSql ? { proposedSql } : {}),
      };
    },
    suggestFix: async (failedSql, opts = {}) => {
      const conn = connectorById(opts.connectionId);
      const bad = (failedSql ?? '').trim();
      const question = (opts.question ?? '').trim();
      // Without the original intent a repair is guesswork - skip.
      if (!bad || !question) return null;
      try {
        const catalog = await getCatalog(conn).catch(() => null);
        if (!catalog) return null;
        const schemaText = pruneCatalog(catalog, question, config.pruner).schemaText;
        const repaired = await callModel({
          model: config.model,
          system: buildSqlSystem(conn.dialect, policy.maxRows, config.prompts),
          prompt: buildRepairUser({
            question,
            failedSql: bad,
            failure: `The database rejected it: ${redactValuesInError(opts.errorDetail ?? 'the query failed to run')}`,
            schemaText,
            dialect: conn.dialect,
          }),
          signal: opts.signal,
          settings: config.llm,
        });
        const ex = extractSql(repaired.text);
        if (!ex) return null;
        const v = guardSql({ sql: ex.sql, dialect: conn.dialect, policy });
        return v.allowed && v.sql !== bad ? v.sql : null;
      } catch {
        return null; // best-effort; the original error stands
      }
    },
    recordFeedback: async (question, sql, fbOpts) => {
      if (!config.fewShots) return;
      const conn = connectorById(fbOpts?.connectionId);
      const q = (question ?? '').trim();
      const s = (sql ?? '').trim();
      if (!q || !s) return;
      // Only store SQL that passes the guard (never memorize an unsafe example).
      const verdict = guardSql({ sql: s, dialect: conn.dialect, policy });
      if (!verdict.allowed) return;
      await config.fewShots.add(conn.id, { question: q, sql: verdict.sql }, fbOpts?.userId);
    },
    close: async () => {
      await Promise.allSettled(config.connectors.map((c) => c.close()));
    },
  };
}

// ---------------------------------------------------------------------------
// Unknown-table detection (hallucination floor)
// ---------------------------------------------------------------------------

import pkg from 'node-sql-parser';
const { Parser } = pkg;
const tableParser = new Parser();

// ---------------------------------------------------------------------------
// Unknown-column detection (hallucination floor, column level)
// ---------------------------------------------------------------------------

export interface UnknownColumn {
  readonly table: string;
  readonly column: string;
  readonly available: readonly string[];
}

/** Collect CTE relation names lexically (WITH x AS (...), y AS (...)). */
function collectCteNames(sql: string): ReadonlySet<string> {
  const names = new Set<string>();
  if (!/\bwith\b/iu.test(sql)) return names;
  // Scans the whole statement; over-collecting CTE names only makes the floor more lenient.
  for (const m of sql.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/giu)) {
    names.add(m[1]!.toLowerCase());
  }
  return names;
}

/** Column aliases introduced by `... AS name`, excluded from the unqualified-column hallucination check. */
function collectSelectAliases(sql: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of sql.matchAll(/\bas\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/giu)) {
    names.add(m[1]!.toLowerCase());
  }
  return names;
}

/**
 * Returns the first column reference whose (alias-resolved) base table exists in the catalog but
 * does not have that column - the column-level hallucination floor. Fails open (returns null) on
 * unqualified columns, wildcards, CTE or derived-table aliases, and any parse failure.
 */
export function firstUnknownColumn(sql: string, catalog: SchemaCatalog, grammar: string): UnknownColumn | null {
  let refs: readonly string[];
  try {
    refs = tableParser.columnList(sql, { database: grammar });
  } catch {
    return null; // the guard already parsed it; never double-block here
  }

  // table name (lowercased) -> its columns; same-named tables across schemas union their columns.
  const byTable = new Map<string, Set<string>>();
  for (const t of catalog.tables) {
    const key = t.name.toLowerCase();
    let set = byTable.get(key);
    if (!set) {
      set = new Set<string>();
      byTable.set(key, set);
    }
    for (const c of t.columns) set.add(c.name.toLowerCase());
  }

  const cteNames = collectCteNames(sql);
  const aliases = collectSelectAliases(sql);

  // The query's base tables that we know; unqualified columns are judged only when all are known.
  const queryTables: string[] = [];
  let attributable = !/\(\s*select\b/iu.test(sql);
  try {
    for (const t of tableParser.tableList(sql, { database: grammar })) {
      let name = (t.split('::')[2] ?? '').toLowerCase();
      if (!name || name === 'null') continue;
      if (name.includes('.')) name = name.slice(name.lastIndexOf('.') + 1);
      if (cteNames.has(name) || SYSTEM_SCHEMAS.has(name)) continue;
      if (byTable.has(name)) queryTables.push(name);
      else attributable = false; // an unknown base table may own the column
    }
  } catch {
    attributable = false;
  }

  for (const ref of refs) {
    const parts = ref.split('::');
    let table = (parts[1] ?? '').toLowerCase();
    const column = (parts[2] ?? '').toLowerCase();
    if (!column || column === '(.*)') continue; // wildcard / empty

    if (!table || table === 'null') {
      // Unqualified: skip aliases, require every base table known, then flag it if no table has it.
      if (!attributable || aliases.has(column) || queryTables.length === 0) continue;
      if (queryTables.some((t) => byTable.get(t)!.has(column))) continue;
      const available = new Set<string>();
      for (const t of queryTables) for (const c of byTable.get(t)!) available.add(c);
      return { table: queryTables[0]!, column, available: [...available].sort() };
    }

    // Qualified: check the bare table name.
    if (table.includes('.')) table = table.slice(table.lastIndexOf('.') + 1);
    if (cteNames.has(table)) continue; // CTE relation - columns are the CTE's own
    if (SYSTEM_SCHEMAS.has(table)) continue;
    const known = byTable.get(table);
    if (!known) continue; // derived/subquery alias or table not in catalog - fail open
    if (known.has(column)) continue; // real column
    return { table, column, available: [...known].sort() };
  }
  return null;
}
