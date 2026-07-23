/**
 * The AskSQL engine: one pipeline for every surface.
 *
 * question -> catalog -> prune -> prompt -> LLM (streamed) -> extract ->
 * GUARD -> repair loop (≤2) -> approval (caller's job) -> execute ->
 * typed ResultSet
 *
 * Invariants: the guard runs on every SQL string before execution (model
 * output, user-edited SQL, replayed history alike); no DB session is held
 * open across an LLM call; on a runtime DB error a repair suggestion is
 * attached to the error for re-approval, never auto-run.
 */

import { joinGraph, pruneCatalog } from './catalog.js';
import { AskSqlError } from './errors.js';
import { extractImpossible, extractSql } from './extract.js';
import { guardSql, resolveGuardPolicy } from './guard.js';
import { historyId, MemoryHistoryStore } from './history.js';
import { callModel } from './llm.js';
import {
  buildExplainSystem,
  buildExplainUser,
  buildRepairUser,
  buildSchemaAnswerRepairUser,
  buildSchemaAnswerSystem,
  buildSchemaAnswerUser,
  buildSqlSystem,
  buildSqlUser,
} from './prompt.js';
import { catalogQueryHint, closestTableName, isMetadataQuestion } from './schema-match.js';
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

const MAX_REPAIRS = 2;
/** "SELECT 'canned reply' AS x" with no FROM: a model faking conversation as data. */
const LITERAL_STRING_ANSWER_RE = /^select\s+'(?:[^']|'')*'\s*(?:as\s+\w+)?\s*(?:limit\s+\d+)?\s*;?\s*$/i;
const CATALOG_TTL_MS = 300_000;
// A partially-failed introspection (warnings present) is cached only briefly so a
// transient permission/network fault self-heals instead of sticking for 5 minutes.
const WARNED_CATALOG_TTL_MS = 30_000;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
/** A question longer than this is almost certainly not a question; reject it before the LLM call. */
const MAX_QUESTION_LENGTH = 10_000;

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
}

export interface SchemaAnswer {
  readonly answer: string;
  /** Catalog tables given to the model as grounding (schema-qualified where applicable). */
  readonly tables: readonly string[];
  /** True unless the answer named a table/column not present in the schema. */
  readonly grounded: boolean;
  /** Identifier-shaped names in the answer absent from the schema. For a schema-change request these are proposed new names; otherwise they are hallucinations. */
  readonly unknownReferences: readonly string[];
  /** The question asked to add/change/remove schema objects, so unknownReferences are proposals AskSQL never runs, not errors. */
  readonly isSchemaChange: boolean;
}

/** A request to add/change/remove schema objects (index, column, table, ...) rather than understand the current schema. */
const SCHEMA_CHANGE_RE = /\b(add|create|extend|alter|drop|remove|rename|migrate|introduce|modify)\b/iu;

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
   * Answer a natural-language question about the schema (what tables exist, how
   * they relate, what a column is for) in prose, grounded in the catalog. Explains
   * structure only - never data values, since no query is run. `grounded` is false
   * if the answer named identifiers absent from the schema.
   */
  explainSchema(question: string, opts?: ExplainSchemaOptions): Promise<SchemaAnswer>;
  /**
   * Given a SQL statement the database rejected, ask the model for a corrected
   * one (grounded in the schema + the original question). Returns the guarded
   * corrected SQL, or null if it can't produce a safe, different suggestion.
   * Never runs the query - the caller decides whether to apply it.
   */
  suggestFix(failedSql: string, opts?: SuggestFixOptions): Promise<string | null>;
  /**
   * Record an approved question->SQL pair for the few-shot loop.
   * No-op when no fewShots store is configured.
   */
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
    // An empty id makes every lookup ambiguous; an empty name shows a blank
    // entry in every picker. Both are silent config mistakes worth catching here.
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
          // Any connector (incl. third-party) failing to connect surfaces as a
          // clean, retryable DB_UNREACHABLE - never a misleading DB_QUERY_ERROR.
          throw AskSqlError.from(err, 'DB_UNREACHABLE');
        } finally {
          connecting.delete(conn.id);
        }
      })();
      connecting.set(conn.id, pending);
    }
    return pending;
  };

  const getCatalog = async (conn: Connector, refresh = false): Promise<SchemaCatalog> => {
    await ensureConnected(conn);
    const cached = catalogCache.get(conn.id);
    if (!refresh && cached && Date.now() - cached.at < cached.ttl) return cached.catalog;
    const running = inflight.get(conn.id);
    if (!refresh && running) return running;
    // eslint-disable-next-line prefer-const -- referenced in the async body's finally, so it must be hoisted.
    let p!: Promise<SchemaCatalog>;
    p = (async () => {
      try {
        const catalog = await conn.introspect();
        // A failed sub-query returns [] and pushes a warning; an empty table set
        // with warnings is a permission/network failure masquerading as an empty
        // database. Surface it and never cache the poisoned result.
        if (catalog.tables.length === 0 && catalog.warnings.length > 0) {
          throw new AskSqlError('DB_QUERY_ERROR', {
            userMessage: "Could not read this database's schema. Check the connection's permissions, then try again.",
            detail: `introspection returned no tables with warnings: ${catalog.warnings.join('; ').slice(0, 500)}`,
            retryable: true,
          });
        }
        const ttl = catalog.warnings.length > 0 ? WARNED_CATALOG_TTL_MS : CATALOG_TTL_MS;
        catalogCache.set(conn.id, { catalog, at: Date.now(), ttl });
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
      // Clamp maxRows to the policy ceiling: fetch-style dialects (Oracle) get no injected LIMIT,
      // so this driver cap is their only bound against materializing the whole table.
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
        warnings.push(`A row limit of ${policy.maxRows} was added automatically - export to get everything.`);
      }
      if (verdict.loweredLimit) {
        warnings.push(`The row limit was lowered to ${policy.maxRows}.`);
      }
      // The injected LIMIT equals maxRows, hiding the overflow row from the connector; treat an
      // auto-limited result that filled the cap as truncated so the "export" banner shows.
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
    const conn = connectorById(opts.connectionId);

    emit({ type: 'stage', stage: 'catalog' }, opts);
    const fullCatalog = await getCatalog(conn);

    emit({ type: 'stage', stage: 'prune' }, opts);
    let pruned = pruneCatalog(fullCatalog, q, config.pruner);
    let schemaText = pruned.schemaText;
    if (pruned.dropped > 0) {
      emit({ type: 'warning', message: `Schema narrowed to ${pruned.catalog.tables.length} relevant tables.` }, opts);
    }

    // Few-shot retrieval: pull approved examples relevant to this question, scoped to the
    // connection and (in server mode) the requesting user - never surface another user's examples.
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
    });

    const usageTotal: { input: number; output: number } = { input: 0, output: 0 };
    let lastSql = '';
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
        // on context overflow, shrink the schema once and retry
        // without consuming a repair attempt.
        if (AskSqlError.is(err) && err.code === 'LLM_CONTEXT_OVERFLOW' && !contextShrunk) {
          contextShrunk = true;
          const tighter = pruneCatalog(fullCatalog, q, {
            maxTables: Math.max(5, Math.floor(pruned.catalog.tables.length / 2)),
            maxSchemaTokens: Math.max(1000, Math.floor((config.pruner?.maxSchemaTokens ?? 6000) / 2)),
          });
          pruned = tighter;
          schemaText = tighter.schemaText;
          // On the shrink retry keep the (small) glossary but drop few-shots
          // to reclaim tokens.
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

      emit({ type: 'stage', stage: 'extract' }, opts);
      // extractSql runs first: a model can hedge with IMPOSSIBLE and still produce
      // usable SQL, and that answer should win over the refusal sentinel.
      const extraction = extractSql(text);
      if (!extraction) {
        const impossible = extractImpossible(text);
        if (impossible) {
          // A structure question ("show tables") is not a SELECT, so the model refuses.
          // Retry once, pointing it at the dialect's read-only catalog listing.
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
        const refusal = /\b(i can(?:no|')t|i cannot|i am unable|i'm unable|i'm sorry|as an ai)\b/iu.test(text);
        if (attempt >= MAX_REPAIRS) {
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

      // A model sometimes dodges a question (e.g. "how are you") by SELECTing a hardcoded string
      // as if it were a real row. Guard allows it (no table touched), so reject it here.
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

      // Hallucination floor: every referenced base relation must exist in the
      // full catalog (pruning must never cause false blocks). Reuse the table
      // list the guard already produced during its single parse.
      const unknownTable = firstUnknownTable(verdict.sql, fullCatalog, conn.dialect.grammar, verdict.tables);
      if (unknownTable) {
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage: `I couldn't find a table called "${unknownTable}" in this database. Try rephrasing, or check the schema.`,
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

      // Column-level hallucination floor: a column attributed to a real base
      // table must exist on it (fail-open on anything ambiguous - see
      // firstUnknownColumn). Catches the common small-model slip of inventing a
      // column name or mis-guessing it (service_name vs service_id) before the
      // query hits the database.
      const unknownColumn = firstUnknownColumn(verdict.sql, fullCatalog, conn.dialect.grammar);
      if (unknownColumn) {
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage: `There's no "${unknownColumn.column}" column on ${unknownColumn.table} in this database. Try rephrasing, or check the schema.`,
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
            // on a runtime DB error, ask for a corrected query but
            // never run it silently - attach it for re-approval.
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
            failure: `The database rejected it: ${dbErr.detail ?? dbErr.userMessage}`,
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
      // Guard first: `sql` is caller-supplied, so without this /explain is a free
      // text channel to the model on the host's API key. It must be explainable
      // read-only SQL to be worth explaining.
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
      const isSchemaChange = SCHEMA_CHANGE_RE.test(q);
      // A whole-schema question ("how are the tables related?", "summarize this database") needs
      // the full picture. Term-based pruning would narrow it to a couple of tables, so instead
      // pass a compact list of ALL tables plus the full join graph (declared + naming-inferred).
      const isBroad = BROAD_SCHEMA_RE.test(q);
      let schemaText: string;
      let relationships: readonly string[];
      let contextTables;
      if (isBroad) {
        relationships = joinGraph(catalog);
        const list = catalog.tables
          .map(
            (t) =>
              `${t.schema ? `${t.schema}.` : ''}${t.name} (${t.kind}, ${t.columns.length} cols${t.primaryKey.length ? `, pk ${t.primaryKey.join(',')}` : ''})`,
          )
          .join('\n');
        schemaText = `This database has exactly ${catalog.tables.length} tables/views. Full list:\n${list}`;
        contextTables = catalog.tables;
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
          prompt: buildSchemaAnswerUser(q, schemaText, relationships),
          signal: opts.signal,
          settings: config.llm,
        })
      ).text.trim();
      // Grounding floor, checked against the full catalog (not the pruned subset, so a real
      // table dropped by pruning isn't flagged).
      let unknownReferences = unknownReferencesInProse(answer, catalog);
      // One repair pass for understanding questions: a name absent from the schema is a
      // hallucination, so regenerate constrained to real names. Skipped for schema-change
      // requests, where new names are the requested proposal, not an error.
      if (unknownReferences.length > 0 && !isSchemaChange) {
        answer = (
          await callModel({
            model: config.model,
            system,
            prompt: buildSchemaAnswerRepairUser(q, schemaText, unknownReferences, relationships),
            signal: opts.signal,
            settings: config.llm,
          })
        ).text.trim();
        unknownReferences = unknownReferencesInProse(answer, catalog);
      }
      return { answer, tables, grounded: unknownReferences.length === 0, unknownReferences, isSchemaChange };
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
            failure: `The database rejected it: ${opts.errorDetail ?? 'the query failed to run'}`,
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

/**
 * Returns the first base relation referenced by the SQL that is missing from
 * the catalog, or null. CTE names count as known relations. Pass the table
 * list the guard already computed (`GuardVerdict.tables`) to avoid a second
 * parse of the same statement; falls back to parsing only if it's absent.
 */
// Standard read-only system catalogs across the supported dialects. Tables in
// these schemas exist by definition, so the hallucination check must not treat
// them as unknown (the guard still enforces read-only access to them).
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
    // System catalogs are real, read-only relations (the guard already permits
    // catalog reads) - a metadata query like "which columns are in orders?"
    // legitimately hits information_schema, so it is not a hallucinated table.
    if (schema && SYSTEM_SCHEMAS.has(schema)) continue;
    if (name.startsWith('sqlite_') || name.startsWith('pg_')) continue;
    return schema ? `${schema}.${name}` : name;
  }
  return null;
}

// SQL vocabulary and types that read like identifiers but never name a table or column - so a
// DDL suggestion's `integer`/`unique` isn't mistaken for a proposed object.
const NON_IDENTIFIER_SNAKE: ReadonlySet<string> = new Set([
  'primary_key',
  'foreign_key',
  'foreign_keys',
  'data_type',
  'data_types',
  'not_null',
  'auto_increment',
  'use_case',
  'read_only',
  'read_write',
  'integer',
  'int',
  'bigint',
  'smallint',
  'serial',
  'bigserial',
  'varchar',
  'char',
  'text',
  'boolean',
  'bool',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'numeric',
  'decimal',
  'real',
  'uuid',
  'json',
  'jsonb',
  'unique',
  'primary',
  'foreign',
  'constraint',
  'references',
  'index',
  'default',
  'cascade',
  'null',
  'column',
  'table',
]);

/**
 * Identifier-shaped names in a prose answer that are absent from the catalog - the
 * grounding floor for explainSchema. Conservative by design: only snake_case tokens and
 * backtick/double-quote-wrapped names are inspected, so ordinary English never trips it
 * while an invented `customer_history` is caught. Real schema names pass (they're in the
 * catalog); a small stopword set covers SQL vocabulary like `foreign_key`.
 */
export function unknownReferencesInProse(answer: string, catalog: SchemaCatalog): string[] {
  const known = new Set<string>();
  for (const s of catalog.schemas) known.add(s.toLowerCase());
  for (const t of catalog.tables) {
    known.add(t.name.toLowerCase());
    if (t.schema) {
      known.add(t.schema.toLowerCase());
      known.add(`${t.schema.toLowerCase()}.${t.name.toLowerCase()}`);
    }
    for (const c of t.columns) known.add(c.name.toLowerCase());
  }
  const found = new Set<string>();
  const re = /`([^`\s]+)`|"([\w.]+)"|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase();
    if (!raw || NON_IDENTIFIER_SNAKE.has(raw)) continue;
    const bare = raw.includes('.') ? (raw.split('.').pop() ?? raw) : raw;
    if (known.has(raw) || known.has(bare)) continue;
    found.add(raw);
  }
  return [...found];
}

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
  const cteRe = /\bwith\s+(?:recursive\s+)?([\s\S]*?)\bselect\b/iu.exec(sql);
  if (cteRe) {
    for (const m of cteRe[1]!.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/giu)) {
      names.add(m[1]!.toLowerCase());
    }
  }
  return names;
}

/**
 * Column aliases introduced by `... AS name` in the SELECT list. An `ORDER BY`
 * or `HAVING` that references such an alias is legitimate, so these are excluded
 * from the unqualified-column hallucination check. Conservative: any `AS name`
 * anywhere in the statement is treated as an alias (over-collecting only ever
 * makes the floor more lenient, never a false positive).
 */
function collectSelectAliases(sql: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of sql.matchAll(/\bas\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/giu)) {
    names.add(m[1]!.toLowerCase());
  }
  return names;
}

/**
 * Returns the first column reference whose (alias-resolved) base table exists
 * in the catalog but does not have that column - the column-level hallucination
 * floor. `columnList` resolves table aliases to their real base table, so
 * `s.id` on `services s` comes back as `services::id`; we then confirm `id` is
 * a real column of `services`.
 *
 * Deliberately fail-open (returns null) on every ambiguity so a valid query is
 * never blocked: unqualified columns (`null` table), `SELECT *` wildcards, CTE
 * or derived-table aliases (not in the catalog), and any parse failure are all
 * skipped. Only a column that is confidently attributable to a known base table
 * and absent from it is flagged.
 */
export function firstUnknownColumn(sql: string, catalog: SchemaCatalog, grammar: string): UnknownColumn | null {
  let refs: readonly string[];
  try {
    refs = tableParser.columnList(sql, { database: grammar });
  } catch {
    return null; // the guard already parsed it; never double-block here
  }

  // table name (lowercased) -> its columns. Same-named tables across schemas
  // union their columns, so a column present in any is treated as known.
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

  // The query's base tables that we know. An unqualified column is judged against
  // them only when every base table is known and there is no subquery, so a column
  // can never legitimately come from a table/derivation we cannot see.
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
      // Unqualified: skip aliases; require every base table known; then it is
      // invented iff none of the query's tables have it.
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
