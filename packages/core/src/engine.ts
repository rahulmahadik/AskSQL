/**
 * The AskSQL engine: one pipeline for every surface.
 *
 * question -> catalog -> prune -> prompt -> LLM (streamed) -> extract ->
 * GUARD -> repair loop (≤2) -> approval (caller's job) -> execute ->
 * typed ResultSet
 *
 * Design invariants:
 * - The guard runs on EVERY SQL string before EVERY execution - model
 * output, user-edited SQL, replayed history alike.
 * - No connector call ever spans an LLM call: never hold a DB session open
 * across a model call (idle connections drop and poison the transaction).
 * - On a runtime DB error the engine may ask the model for a corrected
 * query, but it NEVER silently executes it - the suggestion comes back
 * attached to the error for re-approval (approval-gate integrity).
 */

import { pruneCatalog } from './catalog.js';
import { AskSqlError } from './errors.js';
import { extractImpossible, extractSql } from './extract.js';
import { guardSql, resolveGuardPolicy } from './guard.js';
import { historyId, MemoryHistoryStore } from './history.js';
import { callModel } from './llm.js';
import {
  buildExplainSystem,
  buildExplainUser,
  buildRepairUser,
  buildSqlSystem,
  buildSqlUser,
} from './prompt.js';
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
const CATALOG_TTL_MS = 300_000;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

export interface ExecuteEngineOptions extends ExecuteOptions {
  readonly connectionId?: string;
  /** Recorded into history alongside the SQL. */
  readonly question?: string;
}

export interface ExplainOptions {
  readonly connectionId?: string;
  readonly signal?: AbortSignal;
}

export interface CatalogOptions {
  readonly refresh?: boolean;
}

export interface AskSqlEngine {
  readonly policy: GuardPolicy;
  readonly history: HistoryStore;
  connectors: readonly Pick<Connector, 'id' | 'name' | 'engine'>[];
  catalog(connectionId?: string, opts?: CatalogOptions): Promise<SchemaCatalog>;
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
  execute(sql: string, opts?: ExecuteEngineOptions): Promise<ResultSet>;
  explain(sql: string, opts?: ExplainOptions): Promise<string>;
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
  recordFeedback(question: string, sql: string, opts?: { connectionId?: string }): Promise<void>;
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
    if (ids.has(c.id)) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `duplicate connector id: ${c.id}`,
        userMessage: 'AskSQL is misconfigured: two connections share the same id.',
      });
    }
    ids.add(c.id);
  }

  const policy = resolveGuardPolicy(config.policy);
  const history = config.history ?? new MemoryHistoryStore;
  const catalogCache = new Map<string, { catalog: SchemaCatalog; at: number }>();
  const inflight = new Map<string, Promise<SchemaCatalog>>();

  const connectorById = (connectionId?: string): Connector => {
    const conn = connectionId
      ? config.connectors.find((c) => c.id === connectionId)
      : config.connectors[0];
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
  const ensureConnected = async (conn: Connector): Promise<void> => {
    if (connected.has(conn.id)) return;
    try {
    await conn.connect();
  } catch (err) {
  // Any connector (incl. third-party) failing to connect surfaces as a
  // clean, retryable DB_UNREACHABLE - never a misleading DB_QUERY_ERROR.
  throw AskSqlError.from(err, 'DB_UNREACHABLE');
  }
    connected.add(conn.id);
  };

  const getCatalog = async (conn: Connector, refresh = false): Promise<SchemaCatalog> => {
    await ensureConnected(conn);
    const cached = catalogCache.get(conn.id);
    if (!refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;
    const running = inflight.get(conn.id);
    if (!refresh && running) return running;
    const p = (async () => {
      try {
        const catalog = await conn.introspect();
        catalogCache.set(conn.id, { catalog, at: Date.now() });
        return catalog;
      } finally {
        inflight.delete(conn.id);
      }
    })();
    inflight.set(conn.id, p);
    return p;
  };

  const executeGuarded = async (
    sql: string,
    conn: Connector,
    opts: ExecuteEngineOptions,
  ): Promise<ResultSet> => {
    await ensureConnected(conn);
    const verdict = guardSql({ sql, dialect: conn.dialect, policy });
    if (!verdict.allowed) {
      await history.add({
        id: historyId(),
        at: new Date().toISOString(),
        connectionId: conn.id,
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
      const result = await conn.execute(verdict.sql, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
        maxRows: opts.maxRows ?? policy.maxRows,
      });
      await history.add({
        id: historyId(),
        at: new Date().toISOString(),
        connectionId: conn.id,
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
    return {...result, warnings };
    } catch (err) {
      const mapped = AskSqlError.from(err, 'DB_QUERY_ERROR');
      await history.add({
        id: historyId(),
        at: new Date().toISOString(),
        connectionId: conn.id,
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
    if (q.length > 10_000) {
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
      emit(
        { type: 'warning', message: `Schema narrowed to ${pruned.catalog.tables.length} relevant tables.` },
        opts,
      );
    }

// Few-shot retrieval: pull approved examples relevant to this
// question, scoped to the connection.
const fewShots = config.fewShots
? await config.fewShots.retrieve(conn.id, q, 4).catch(() => [])
: [];

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
      const impossible = extractImpossible(text);
      if (impossible) {
        throw new AskSqlError('LLM_BAD_OUTPUT', {
          userMessage: `This can't be answered from the connected schema: ${impossible}`,
          detail: 'model returned IMPOSSIBLE sentinel',
          retryable: false,
        });
      }
      const extraction = extractSql(text);
      if (!extraction) {
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

// Hallucination floor: every referenced base relation must exist in the
// FULL catalog (pruning must never cause false blocks). Reuse the table
// list the guard already produced during its single parse.
const unknownTable = firstUnknownTable(verdict.sql, fullCatalog, conn.dialect.grammar, verdict.tables);
      if (unknownTable) {
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage: `The AI referenced a table that doesn't exist (${unknownTable}). Try rephrasing the question.`,
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
      // column name or mis-guessing it (service_name vs service_id) BEFORE the
      // query hits the database.
      const unknownColumn = firstUnknownColumn(verdict.sql, fullCatalog, conn.dialect.grammar);
      if (unknownColumn) {
        if (attempt >= MAX_REPAIRS) {
          throw new AskSqlError('LLM_BAD_OUTPUT', {
            userMessage: `The AI used a column that doesn't exist (${unknownColumn.table}.${unknownColumn.column}). Try rephrasing the question.`,
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

      const engineExecute = executeGuarded;
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
            return await engineExecute(finalSql, conn, {...execOpts, question: q });
          } catch (err) {
          // on a runtime DB error, ask for a corrected query but
            // NEVER run it silently - attach it for re-approval.
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
    connectors: config.connectors.map((c) => ({ id: c.id, name: c.name, engine: c.engine })),
    catalog: (connectionId, opts) => getCatalog(connectorById(connectionId), opts?.refresh ?? false),
    ask: askImpl,
    execute: (sql, opts = {}) => executeGuarded(sql, connectorById(opts.connectionId), opts),
    explain: async (sql, opts = {}) => {
      const conn = connectorById(opts.connectionId);
      const s = (sql ?? '').trim();
      if (!s) throw new AskSqlError('INVALID_INPUT', { userMessage: 'Provide a SQL statement to explain.' });
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
  await config.fewShots.add(conn.id, { question: q, sql: verdict.sql });
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
// Collect CTE names lexically (WITH x AS, y AS ...) - they count as known.
  const cteNames = new Set<string>();
  const cteRe = /\bwith\s+(?:recursive\s+)?([\s\S]*?)\bselect\b/iu.exec(sql);
  if (cteRe) {
    for (const m of cteRe[1]!.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/giu)) {
      cteNames.add(m[1]!.toLowerCase());
    }
  }
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
 * Returns the first column reference whose (alias-resolved) base table exists
 * in the catalog but does NOT have that column - the column-level hallucination
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
export function firstUnknownColumn(
  sql: string,
  catalog: SchemaCatalog,
  grammar: string,
): UnknownColumn | null {
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

  for (const ref of refs) {
    const parts = ref.split('::');
    let table = (parts[1] ?? '').toLowerCase();
    const column = (parts[2] ?? '').toLowerCase();
    if (!table || table === 'null') continue; // unqualified - cannot safely attribute
    if (!column || column === '(.*)') continue; // wildcard / empty
    // A schema-qualified table (schema.table) - check the bare name.
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
