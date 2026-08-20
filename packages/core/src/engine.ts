/**
 * The AskSQL engine: one pipeline for every surface.
 * question -> catalog -> prune -> prompt -> LLM (streamed) -> extract -> GUARD -> repair loop
 * (≤2) -> approval (caller's job) -> execute -> typed ResultSet.
 * The guard runs on every SQL string before execution; no DB session is held open across an LLM call.
 */

import { joinGraph, needsQuoting, pruneCatalog } from './catalog.js';
import { catalogQueryFor } from './catalog-answers.js';
import {
  correctTableCase,
  foldingFor,
  looksLikeUnknownTable,
  hasUnterminatedLiteral,
  quoteCatalogIdentifiers,
  quoteReservedAliases,
  withoutLiteralsAndComments,
} from './identifier-case.js';
import { withoutFetchTail } from './strip.js';
import { AskSqlError } from './errors.js';
import { extractImpossible, extractSql } from './extract.js';
import { guardSql, resolveGuardPolicy } from './guard.js';
import { sanitizeValue } from './catalog.js';
import { codeLiterals, epochUnitMismatch, fanOutAggregate, nestedAggregate, ungroupedAggregate } from './semantics.js';
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
  isRelationshipQuestion,
  isSchemaAdviceQuestion,
  isRerunPreviousRequest,
  isSchemaProposalQuestion,
  isWriteRequest,
  namesSomethingInCatalog,
} from './schema-match.js';
import { mentionsCatalogName, SCHEMA_CHANGE_RE, unknownReferencesInProse } from './grounding.js';
export { unknownReferencesInProse } from './grounding.js';
import {
  capabilityAnswer,
  danglingReference,
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
      .replace(/(date\/time field value out of range:\s*)"[^"]*"/gi, '$1"..."')
      .replace(/(value out of range[^:"]{0,20}:\s*)"[^"]*"/gi, '$1"..."')
      .replace(/(invalid input value for enum \w+:\s*)"[^"]*"/gi, '$1"..."')
      // Postgres appends the WHOLE offending row as a DETAIL on a constraint violation.
      .replace(/(failing row contains\s*)\([^)]*\)/gi, '$1(...)')
      // Oracle carries the value after the message rather than in quotes.
      .replace(
        /((?:ORA-\d+:\s*)?(?:invalid number|character to number conversion error)[^\n]{0,3}:\s*)[^\n]+/gi,
        '$1...',
      )
      .replace(/"[^"]{60,}"/g, '"..."')
  ); // nothing names an identifier this long
}

const MAX_REPAIRS = 2;
/** "SELECT 'canned reply' AS x" with no FROM: a model faking conversation as data. */
const LITERAL_STRING_ANSWER_RE = /^select\s+'(?:[^']|'')*'\s*(?:as\s+\w+)?\s*(?:limit\s+\d+)?\s*;?\s*$/i;
/** At most one staleness-driven re-read per connection in this window. */
const STALE_REFRESH_COOLDOWN_MS = 30_000;

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
      list = tableParser.tableList(withoutFetchTail(sql), { database: grammar });
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
    // MongoDB speaks pipelines, not SQL, and belongs to createMongoAskSql. Without this the
    // missing dialect surfaces much later as a property read on undefined while building a prompt.
    if (!c.dialect) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `connector "${c.id}" has no dialect; a MongoDB connection belongs to createMongoAskSql`,
        userMessage: 'AskSQL is misconfigured: this connection type cannot answer SQL questions.',
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

  // History is telemetry: a failed write must never mask the query's own outcome
  // (a successful result, a guard block, or the real database error).
  const recordHistory = async (entry: Parameters<HistoryStore['add']>[0]): Promise<void> => {
    try {
      await history.add(entry);
    } catch {
      emit({ type: 'warning', message: 'Could not record this query in history.' });
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

  /** Distinct values past this many mean a measurement, not a code, and the query is left alone. */
  const CODE_MAX_DISTINCT = 25;
  /** At most this many columns are confirmed per question, and none may hold the answer up for long. */
  const CODE_MAX_PROBES = 2;
  const CODE_PROBE_TIMEOUT_MS = 1200;

  /** The distinct values a coded column holds, kept local. Null when not certain: a wrong caveat is worse than none. */
  async function codeValuesOf(
    conn: Connector,
    schema: string | undefined,
    table: string,
    column: string,
    signal: AbortSignal | undefined,
  ): Promise<string[] | null> {
    const q = conn.dialect.quoteChar;
    const id = (name: string) => `${q}${name.split(q).join(q + q)}${q}`;
    // Qualified when the catalog knows a schema: an unqualified name resolves only inside search_path,
    // so the probe errored, the catch returned null, and the check went quiet for every other schema.
    const relation = schema ? `${id(schema)}.${id(table)}` : id(table);
    const select = `SELECT DISTINCT ${id(column)} AS v FROM ${relation}`;
    const cap = CODE_MAX_DISTINCT + 1;
    const capped =
      conn.dialect.limitStyle === 'fetch' ? `${select} FETCH FIRST ${cap} ROWS ONLY` : `${select} LIMIT ${cap}`;
    try {
      const probe = await conn.execute(capped, {
        signal,
        timeoutMs: CODE_PROBE_TIMEOUT_MS,
        maxRows: cap,
      });
      if (probe.rows.length === 0 || probe.rows.length > CODE_MAX_DISTINCT) return null;
      return probe.rows.map((r) => String(r[0] ?? '')).filter((v) => v !== '');
    } catch {
      return null; // a probe that cannot answer says nothing
    }
  }

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

  /**
   * A forced re-read skips the TTL and the inflight dedup, and most business questions name nothing
   * in the catalog, so doing it per question meant a full introspection on nearly every ask. One per
   * cooldown still notices a table added mid-session, which is the point of the re-read.
   */
  const staleRefreshAt = new Map<string, number>();
  const mayRefreshForStaleness = (connectionId: string): boolean => {
    const last = staleRefreshAt.get(connectionId) ?? 0;
    if (Date.now() - last < STALE_REFRESH_COOLDOWN_MS) return false;
    staleRefreshAt.set(connectionId, Date.now());
    return true;
  };

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

  const executeGuarded = async (
    sql: string,
    conn: Connector,
    opts: ExecuteEngineOptions & {
      /**
       * The ask-time verdict. Re-guarding SQL that already carries the injected LIMIT reports
       * autoLimited=false, so a result filled to the cap came back truncated=false with no warning -
       * the reader saw the first 50 of 16,000 rows and nothing said so.
       */
      priorVerdict?: { autoLimited: boolean; loweredLimit: boolean };
    },
  ): Promise<ResultSet> => {
    await ensureConnected(conn);
    const verdict = guardSql({ sql, dialect: conn.dialect, policy });
    if (!verdict.allowed) {
      await recordHistory({
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
      await recordHistory({
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
      const autoLimited = verdict.autoLimited || opts.priorVerdict?.autoLimited === true;
      const loweredLimit = verdict.loweredLimit || opts.priorVerdict?.loweredLimit === true;
      if (autoLimited) {
        warnings.push(`A row limit of ${policy.maxRows} was added automatically - these are the first rows only.`);
      }
      if (loweredLimit) {
        warnings.push(`The row limit was lowered to ${policy.maxRows}.`);
      }
      // An auto-limited result that filled the cap counts as truncated: the injected LIMIT hides the overflow row.
      const truncated = result.truncated || (autoLimited && result.rowCount >= cappedMax);
      return { ...result, warnings, truncated };
    } catch (err) {
      // A driver may reject a cancelled query with its own AbortError rather than
      // AskSqlError('CANCELLED'); "the query failed" would be the wrong story for the user.
      const cancelled = (opts.signal?.aborted ?? false) && !AskSqlError.is(err);
      const mapped = AskSqlError.from(err, cancelled ? 'CANCELLED' : 'DB_QUERY_ERROR');
      await recordHistory({
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
    if (isSchemaAdviceQuestion(q) || isDatabaseOverviewQuestion(q) || isRelationshipQuestion(q)) {
      throw new AskSqlError('LLM_BAD_OUTPUT', {
        userMessage: 'That asks about the schema itself rather than the data in it, so there is no query to run.',
        detail: 'schema-advice question routed to the prose path',
        retryable: false,
      });
    }
    const conn = connectorById(opts.connectionId);

    emit({ type: 'stage', stage: 'catalog' }, opts);
    let fullCatalog = await getCatalog(conn);
    // A question naming nothing we hold usually means the catalog is stale, not that the question is
    // wrong. Gated on age because a refresh skips both the TTL and the inflight dedup, and most
    // business questions name nothing in the catalog either.
    if (!namesSomethingInCatalog(q, fullCatalog) && mayRefreshForStaleness(conn.id)) {
      fullCatalog = await getCatalog(conn, true).catch(() => fullCatalog);
    }
    // Names the engine would not read back as themselves: folded case, reserved words, symbols.
    // A name spelled two ways across the catalog is skipped: rewriting "status" to "Status" would
    // ask one table for another table's column.
    const allNames = fullCatalog.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]);
    const spellings = new Map<string, Set<string>>();
    for (const n of allNames) {
      const key = n.toLowerCase();
      const set = spellings.get(key) ?? new Set<string>();
      set.add(n);
      spellings.set(key, set);
    }
    const quotableNames = allNames.filter(
      (n) => needsQuoting(n, conn.engine) && spellings.get(n.toLowerCase())?.size === 1,
    );
    // Only a table may be quoted before a dot; a schema qualifier that matched a column name broke it.
    const quotableTables = fullCatalog.tables.map((t) => t.name).filter((n) => quotableNames.includes(n));

    // A handful of structure questions have an exact answer, and a model reliably guesses the
    // system-catalog columns wrong. Writing those here skips the model rather than repairing it.
    const written = catalogQueryFor(q, fullCatalog, conn.dialect);
    if (written) {
      const verdict = guardSql({ sql: written.sql, dialect: conn.dialect, policy });
      if (verdict.allowed) {
        emit({ type: 'stage', stage: 'done' }, opts);
        return {
          sql: verdict.sql,
          explanation: written.explanation,
          guard: verdict,
          connectionId: conn.id,
          usage: { inputTokens: 0, outputTokens: 0 },
          repairs: 0,
          run: (execOpts?: ExecuteOptions) =>
            executeGuarded(verdict.sql, conn, { ...execOpts, question: q, userId: opts.userId }),
        };
      }
    }

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
      database: conn.database,
      schemas: fullCatalog.schemas,
      catalogHint: isMetadataQuestion(q) ? catalogQueryHint(conn.dialect.engine) : undefined,
    });

    const usageTotal: { input: number; output: number } = { input: 0, output: 0 };
    let lastSql = '';
    // A model that says nothing on EVERY attempt is unreachable; one quiet repair round is not.
    let everyReplyEmpty = true;
    const semanticNotes: string[] = [];
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
            database: conn.database,
            schemas: fullCatalog.schemas,
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
      // Quote first: a folding engine resolves a bare name elsewhere, and the parser cannot read a
      // bare table named like a keyword. Falls back untouched if quoting makes it unparseable.
      const quotedNames = quoteCatalogIdentifiers(
        extraction.sql,
        quotableNames,
        conn.dialect.quoteChar,
        quotableTables,
      );
      // A reserved word used as an alias only needs quoting: MySQL rejects `... AS rank` outright.
      const withAliases = quoteReservedAliases(quotedNames ?? extraction.sql, conn.dialect.quoteChar, conn.engine);
      const normalised = withAliases ?? quotedNames;
      const normalisedVerdict = normalised ? guardSql({ sql: normalised, dialect: conn.dialect, policy }) : null;
      // Falling straight back to the model's SQL would drop the identifier quoting too, and on a
      // folding engine that quoting is what makes a mixed-case name resolve at all.
      const namesOnlyVerdict =
        !normalisedVerdict?.allowed && quotedNames && quotedNames !== normalised
          ? guardSql({ sql: quotedNames, dialect: conn.dialect, policy })
          : null;
      const verdict = normalisedVerdict?.allowed
        ? normalisedVerdict
        : namesOnlyVerdict?.allowed
          ? namesOnlyVerdict
          : guardSql({ sql: extraction.sql, dialect: conn.dialect, policy });
      if (!verdict.allowed) {
        if (attempt >= MAX_REPAIRS) {
          await recordHistory({
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
        // The validator's parser does not accept WITHIN GROUP on every dialect, so a statement using
        // it is rejected even though the database would run it. Say so, rather than let the model
        // send the same thing back until the attempts run out.
        const orderedSetHint = /\bwithin\s+group\b/i.test(withoutLiteralsAndComments(extraction.sql))
          ? ' The safety validator cannot read WITHIN GROUP here. Answer without it: return the rows themselves rather than concatenating them into one value.'
          : '';
        // "could not parse" alone leaves the model repeating the same statement; name the real cause.
        const quoteHint = hasUnterminatedLiteral(extraction.sql, conn.dialect.quoteChar === '`')
          ? " A text value contains an apostrophe that is not escaped: write it doubled, as 'O''Brien'."
          : '';
        userPrompt = buildRepairUser({
          question: q,
          failedSql: extraction.sql,
          failure: `The SQL validator rejected it: ${verdict.reason ?? verdict.ruleId ?? 'not allowed'}.${quoteHint}${orderedSetHint} Produce a single read-only SELECT.`,
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
        // The column repair already names the real columns; give the table repair the same head start.
        const nearest = closestTableName(unknownTable, fullCatalog);
        userPrompt = buildRepairUser({
          question: q,
          allowImpossible: true,
          failedSql: verdict.sql,
          failure:
            `Table "${unknownTable}" does not exist in the schema.${nearest ? ` Did you mean "${nearest}"?` : ''} ` +
            'Use only tables from the <schema> block.',
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }

      // Semantic floor: a column two joined tables both own. Every engine rejects it unqualified.
      const ambiguous = ambiguousColumn(verdict.sql, fullCatalog, conn.dialect.grammar);
      if (ambiguous && attempt < MAX_REPAIRS) {
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          failure:
            `"${ambiguous}" exists on more than one of the joined tables, so on its own it is ambiguous. ` +
            'Qualify it with the table or alias it belongs to.',
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

      // Semantic floor: AVG(SUM(x)) and friends. Every engine rejects it, so repair before executing.
      const nested = nestedAggregate(verdict.sql, conn.dialect.grammar);
      if (nested && attempt < MAX_REPAIRS) {
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          failure:
            `${nested}() contains another aggregate, which no SQL engine allows. ` +
            'Aggregate once over the rows, or aggregate the inner result in a subquery or CTE and then aggregate that.',
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }

      // Semantic floor: a one-to-many join multiplies the rows a SUM sees, so the total is inflated.
      const fanOut = fanOutAggregate(verdict.sql, conn.dialect.grammar, fullCatalog);
      // Out of repair attempts, the floor still speaks: the inflated total is reported, not hidden.
      if (fanOut && attempt >= MAX_REPAIRS) {
        semanticNotes.push(
          `This sums "${fanOut.parent}.${fanOut.column}" across a join to "${fanOut.child}", which has many rows per ` +
            `"${fanOut.parent}" row, so the total is counted more than once and is too high.`,
        );
      }
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

      // Semantic floor: a column that stores a moment as a number, compared against a date. Wrong
      // whichever way the engine resolves it - an empty result reported as zero, or every row
      // matching because seconds were compared with milliseconds - and it never errors.
      const epoch = epochUnitMismatch(verdict.sql, conn.dialect.grammar, fullCatalog);
      if (epoch && attempt >= MAX_REPAIRS) {
        semanticNotes.push(
          `This compares "${epoch.column}", which is ${epoch.dbType}, against ${epoch.comparedTo}. A number and a ` +
            'date are not the same kind of value, so the rows selected are not the rows the question asked for.',
        );
      }
      if (epoch && attempt < MAX_REPAIRS) {
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          failure:
            `"${epoch.column}" is ${epoch.dbType}, so it holds a number, not a date, and comparing it with ` +
            `${epoch.comparedTo} does not select the rows intended: against text nothing matches, and against ` +
            'epoch seconds a column of milliseconds matches everything. Compare it in its own units - build the ' +
            "bound as a number, for example (strftime('%s','now') - 7*86400) * 1000 for milliseconds - or convert " +
            'the column with the matching divisor before comparing.',
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
        // Naming the table that DOES have the column, and the join that reaches it, is what lets a
        // small model add the missing join rather than rename the alias and fail the same way again.
        // A common column name sits on many tables, so only the ones reachable by a declared join
        // are named: listing the rest is noise that buries the answer.
        // One reachable table and one join, in the catalog's own spelling. Measured on a 7B model:
        // naming several owners and several edges recovers nothing, this recovers every time.
        const lowerTable = unknownColumn.table.toLowerCase();
        const lowerColumn = unknownColumn.column.toLowerCase();
        const owners = fullCatalog.tables
          .filter(
            (t) => t.name.toLowerCase() !== lowerTable && t.columns.some((c) => c.name.toLowerCase() === lowerColumn),
          )
          .map((t) => t.name);
        const graph = joinGraph(fullCatalog);
        const edgesFor = (owner: string): string[] =>
          graph.filter((e) => {
            const line = e.toLowerCase();
            return line.includes(`${lowerTable}.`) && line.includes(`${owner.toLowerCase()}.`);
          });
        const reachable = owners.find((o) => edgesFor(o).length > 0);
        const whereItLives = reachable
          ? ` ${unknownColumn.column} is a column of ${reachable}. Reach it with: ${edgesFor(reachable)[0]}.`
          : owners.length
            ? ` ${unknownColumn.column} is a column of ${owners[0]}.`
            : '';
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          allowImpossible: true,
          failure:
            `Column "${unknownColumn.column}" does not exist on table "${unknownColumn.table}". ` +
            `Its real columns are: ${unknownColumn.available.join(', ')}.${whereItLives} ` +
            'Use only columns shown in the <schema> block.',
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }

      // Coded-value floor: `status = 2` where no row has 2 returns a zero indistinguishable from a true
      // one. Naming the real values to the model is row data, which only `allowDataInPrompt` permits.
      // Grouped by column before slicing: sliced by literal, `status IN (0,1) AND total_cents = 9`
      // spent both probes re-reading `status` and never looked at the column that was actually absent.
      const byColumn = new Map<string, ReturnType<typeof codeLiterals>>();
      for (const candidate of codeLiterals(verdict.sql, conn.dialect.grammar, fullCatalog)) {
        const key = `${candidate.schema ?? ''}.${candidate.table}.${candidate.column}`.toLowerCase();
        const group = byColumn.get(key);
        if (group) group.push(candidate);
        else byColumn.set(key, [candidate]);
      }
      const codes = [...byColumn.values()].slice(0, CODE_MAX_PROBES).map((group) => group[0]!);
      let impossible: { column: string; literal: number; values: string[] } | null = null;
      for (const candidate of codes) {
        const values = await codeValuesOf(conn, candidate.schema, candidate.table, candidate.column, opts.signal);
        // Numerically, not textually: NUMERIC(5,2) renders 18 as "18.00", and comparing the strings
        // reported a value as absent while the query it came from was returning rows.
        if (!values || values.some((v) => v === String(candidate.literal) || Number(v) === candidate.literal)) continue;
        impossible = { column: `${candidate.table}.${candidate.column}`, literal: candidate.literal, values };
        break;
      }
      if (impossible && attempt < MAX_REPAIRS && config.allowDataInPrompt === true) {
        userPrompt = buildRepairUser({
          question: q,
          failedSql: verdict.sql,
          allowImpossible: true,
          failure:
            `No row has ${impossible.column} = ${impossible.literal}. The values it actually holds are: ` +
            `${impossible.values.map(sanitizeValue).join(', ')}. Pick from those, and if none of them answers the question, ` +
            'say so rather than choosing one.',
          schemaText,
          dialect: conn.dialect,
        });
        continue;
      }
      if (impossible) {
        // No data opt-in: the values stay out of the prompt, so the caveat goes to the reader.
        semanticNotes.push(
          `No row has ${impossible.column} = ${impossible.literal}, so this returns nothing for that ` +
            'reason rather than because nothing matched the question. If it is a status or type code, ' +
            'what each value means is defined in the application, not the database.',
        );
      }

      // Non-blocking: the query still runs. A pronoun with no antecedent means the model chose a
      // subject on its own, which is worth saying rather than refusing over.
      const dangling = danglingReference(q, hasUsableContext(opts.context));
      const notes = [...semanticNotes];
      const danglingNotes = dangling
        ? [
            `"${dangling}" does not refer to anything earlier in this conversation, so the query below ` +
              'picked a subject on its own. Name who you mean and ask again if that is wrong.',
          ]
        : [];
      notes.push(...danglingNotes);
      for (const note of notes) emit({ type: 'warning', message: note }, opts);

      emit({ type: 'stage', stage: 'done' }, opts);
      const folding = foldingFor(conn.engine);
      const finalSql = verdict.sql;
      const explanation = extraction.explanation;
      const usage: LlmUsage = { inputTokens: usageTotal.input, outputTokens: usageTotal.output };
      const repairs = attempt;

      return {
        sql: finalSql,
        explanation,
        guard: notes.length > 0 ? { ...verdict, warnings: [...verdict.warnings, ...notes] } : verdict,
        connectionId: conn.id,
        usage,
        repairs,
        run: async (execOpts?: ExecuteOptions): Promise<ResultSet> => {
          emit({ type: 'stage', stage: 'execute' }, opts);
          try {
            return await executeGuarded(finalSql, conn, {
              ...execOpts,
              question: q,
              userId: opts.userId,
              priorVerdict: { autoLimited: verdict.autoLimited, loweredLimit: verdict.loweredLimit },
            });
          } catch (err) {
            // on a runtime DB error, attach a corrected query for re-approval rather than running it.
            // Never after a cancel: a repair would fire a fresh provider request the user just declined to wait for.
            const wasCancelled = (execOpts?.signal?.aborted ?? false) || (opts.signal?.aborted ?? false);
            if (AskSqlError.is(err) && err.code === 'DB_QUERY_ERROR' && !wasCancelled) {
              // A wrong-cased table is repairable from the catalog alone, so try that before the model.
              const suggestion = caseFixFor(err) ?? (await tryRepairAfterDbError(err));
              if (suggestion) (err as DbErrorWithSuggestion).suggestedSql = suggestion;
            }
            throw err;
          }
        },
      };

      function caseFixFor(dbErr: AskSqlError): string | null {
        const message = dbErr.detail ?? dbErr.userMessage ?? '';
        if (!looksLikeUnknownTable(message)) return null;
        const fixed = correctTableCase(
          finalSql,
          fullCatalog.tables.map((t) => t.name),
          conn.dialect.quoteChar,
          folding,
        );
        if (!fixed) return null;
        const v = guardSql({ sql: fixed, dialect: conn.dialect, policy });
        return v.allowed ? v.sql : null;
      }

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
      // A write request is a proposal too, and AskSQL has promised to write the statement out. The
      // model is neither offered the refusal nor left unable to state the statement.
      const proposesWrite = isWriteRequest(q);
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
      const system = buildSchemaAnswerSystem(conn.dialect, isSchemaChange || proposesWrite, !proposesWrite);
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
        looksDatabaseRelated(q) ||
        isSchemaChange ||
        proposesWrite ||
        mentionsCatalogName(q, catalog) ||
        hasUsableContext(opts.context);
      if (isOffTopic(answer) || (isDegenerateAnswer(answer) && !PROPOSED_WRITE_RE.test(answer))) {
        // Challenge the refusal once when the question is plainly about data; accept it otherwise.
        if (!questionIsAboutThisDatabase) return offTopicAnswer(conn.dialect.promptLabel);
        answer = (
          await callModel({
            model: config.model,
            // No sentinel in this system prompt: the question is already known to be about data.
            system: buildSchemaAnswerSystem(conn.dialect, isSchemaChange || proposesWrite, false),
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
            system: buildSchemaAnswerSystem(conn.dialect, isSchemaChange || proposesWrite, false),
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
        // A wrong-cased table is repairable from the catalog alone, the same as ask().run() does.
        if (looksLikeUnknownTable(opts.errorDetail ?? '')) {
          const cased = correctTableCase(
            bad,
            catalog.tables.map((t) => t.name),
            conn.dialect.quoteChar,
            foldingFor(conn.engine),
          );
          if (cased) {
            const casedVerdict = guardSql({ sql: cased, dialect: conn.dialect, policy });
            if (casedVerdict.allowed) return casedVerdict.sql;
          }
        }
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
        if (!v.allowed || v.sql === bad) return null;
        // The same hallucination floors ask() enforces; a fix naming a missing table is not a fix.
        if (firstUnknownTable(v.sql, catalog, conn.dialect.grammar, v.tables)) return null;
        if (firstUnknownColumn(v.sql, catalog, conn.dialect.grammar)) return null;
        return v.sql;
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

// Unknown-table detection (hallucination floor).

import pkg from 'node-sql-parser';
const { Parser } = pkg;
const tableParser = new Parser();

// Unknown-column detection (hallucination floor, column level).

export interface UnknownColumn {
  /** The table as the catalog spells it, so a message about it matches the query and the schema. */
  readonly table: string;
  readonly column: string;
  readonly available: readonly string[];
}

/** Collect CTE relation names lexically (WITH x AS (...), y AS (...)). */
function collectCteNames(sql: string): ReadonlySet<string> {
  const names = new Set<string>();
  if (!/\bwith\b/iu.test(sql)) return names;
  // Scans the whole statement; over-collecting CTE names only makes the floor more lenient.
  // The quote characters matter: normalisation may have quoted a CTE named like a catalog column,
  // and a model can quote one itself. An unrecognised CTE reads as a hallucinated table.
  for (const m of sql.matchAll(/["`[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+as\s*\(/giu)) {
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
 * Columns SQLite gives every table without listing them, so `PRAGMA table_info` never reports them.
 * On a WITHOUT ROWID table the database rejects the name, which the repair loop can act on; refusing
 * here blocked SQL that works.
 */
const SQLITE_IMPLICIT_COLUMNS: ReadonlySet<string> = new Set(['rowid', 'oid', '_rowid_', 'docid', 'rank']);

/**
 * Returns the first column reference whose base table exists in the catalog but
 * does not have that column - the column-level hallucination floor. Fails open (returns null) on
 * unqualified columns, wildcards, CTE or derived-table aliases, and any parse failure.
 */
/**
 * An unqualified column more than one table in the FROM list owns. Every engine rejects it, so
 * catching it here saves a database round trip. USING and NATURAL joins make it legal, and are
 * left alone.
 */
export function ambiguousColumn(sql: string, catalog: SchemaCatalog, grammar: string): string | null {
  const code = withoutLiteralsAndComments(sql);
  if (/\b(using|natural)\b/iu.test(code)) return null;
  // The same attributability limits as the unknown-column floor: one scope only.
  if (/\(\s*select\b/iu.test(code) || /\b(union|intersect|except)\b/iu.test(code)) return null;

  let refs: readonly string[];
  let names: readonly string[];
  try {
    refs = tableParser.columnList(withoutFetchTail(sql), { database: grammar });
    names = tableParser.tableList(withoutFetchTail(sql), { database: grammar });
  } catch {
    return null; // the guard already parsed it; never double-block here
  }

  const byTable = new Map<string, Set<string>>();
  for (const t of catalog.tables) {
    const key = t.name.toLowerCase();
    const set = byTable.get(key) ?? new Set<string>();
    for (const c of t.columns) set.add(c.name.toLowerCase());
    byTable.set(key, set);
  }

  const cteNames = collectCteNames(sql);
  const queryTables: string[] = [];
  for (const entry of names) {
    let name = (entry.split('::')[2] ?? '').toLowerCase();
    if (!name || name === 'null') continue;
    if (name.includes('.')) name = name.slice(name.lastIndexOf('.') + 1);
    if (cteNames.has(name) || SYSTEM_SCHEMAS.has(name)) return null; // scope we cannot model
    if (!byTable.has(name)) return null; // an unknown table may own the column
    queryTables.push(name);
  }
  if (queryTables.length < 2) return null;

  const aliases = collectSelectAliases(sql);
  for (const ref of refs) {
    const parts = ref.split('::');
    const table = (parts[1] ?? '').toLowerCase();
    const column = (parts[2] ?? '').toLowerCase();
    if (!column || column === '(.*)') continue;
    if (table && table !== 'null') continue; // already qualified
    if (aliases.has(column)) continue;
    const owners = queryTables.filter((t) => byTable.get(t)!.has(column));
    if (owners.length > 1) return column;
  }
  return null;
}

export function firstUnknownColumn(sql: string, catalog: SchemaCatalog, grammar: string): UnknownColumn | null {
  let refs: readonly string[];
  try {
    refs = tableParser.columnList(withoutFetchTail(sql), { database: grammar });
  } catch {
    return null; // the guard already parsed it; never double-block here
  }

  // table name (lowercased) -> its columns; same-named tables across schemas union their columns.
  const byTable = new Map<string, Set<string>>();
  // The same keys mapped to the spelling the catalog uses, for messages that match the query.
  const realName = new Map<string, string>();
  const realColumns = new Map<string, string[]>();
  for (const t of catalog.tables) {
    const key = t.name.toLowerCase();
    let set = byTable.get(key);
    if (!set) {
      set = new Set<string>();
      byTable.set(key, set);
    }
    for (const c of t.columns) set.add(c.name.toLowerCase());
    realName.set(key, t.name);
    realColumns.set(key, [...(realColumns.get(key) ?? []), ...t.columns.map((c) => c.name)]);
  }

  const cteNames = collectCteNames(sql);
  const aliases = collectSelectAliases(sql);

  // The query's base tables that we know; unqualified columns are judged only when all are known.
  const queryTables: string[] = [];
  // A set operation has one column list per branch, and the parser reports them merged, so a column
  // from one branch would be judged against another branch's tables. Not attributable, like a subquery.
  const code = withoutLiteralsAndComments(sql);
  let attributable = !/\(\s*select\b/iu.test(code) && !/\b(union|intersect|except)\b/iu.test(code);
  try {
    for (const t of tableParser.tableList(withoutFetchTail(sql), { database: grammar })) {
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
      if (catalog.engine === 'sqlite' && SQLITE_IMPLICIT_COLUMNS.has(column)) continue;
      if (queryTables.some((t) => byTable.get(t)!.has(column))) continue;
      const available = new Set<string>();
      for (const t of queryTables) for (const c of realColumns.get(t) ?? []) available.add(c);
      const owner = queryTables[0]!;
      return { table: realName.get(owner) ?? owner, column, available: [...available].sort() };
    }

    // Qualified: check the bare table name. The parser resolves a table alias to its base table,
    // so `a.name` arrives here as `album::name` and needs no alias handling of our own.
    if (table.includes('.')) table = table.slice(table.lastIndexOf('.') + 1);
    if (cteNames.has(table)) continue; // CTE relation - columns are the CTE's own
    if (SYSTEM_SCHEMAS.has(table)) continue;
    const known = byTable.get(table);
    if (!known) continue; // derived/subquery alias or table not in catalog - fail open
    if (known.has(column)) continue; // real column
    if (catalog.engine === 'sqlite' && SQLITE_IMPLICIT_COLUMNS.has(column)) continue;
    return { table, column, available: [...known].sort() };
  }
  return null;
}
