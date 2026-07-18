/**
 * Public type contracts for AskSQL.
 *
 * Everything here is semver-stable API: connectors, catalogs, results,
 * guard policy, engine configuration. Database drivers never appear in
 * this package - connectors implement {@link Connector} in their own
 * adapter packages (`@asksql/postgres`, `@asksql/mysql`, ...).
 */

import type { LanguageModel } from 'ai';

// ---------------------------------------------------------------------------
// Engines & dialects
// ---------------------------------------------------------------------------

/** Built-in engine identifiers. Future engines use their own string. */
export type EngineKind = 'postgres' | 'mysql' | 'sqlite' | 'duckdb' | (string & {});

/** Grammar names understood by the AST guard (node-sql-parser). */
export type GuardGrammar = 'Postgresql' | 'MySQL' | 'Sqlite';

/**
 * Everything the prompt builder and guard need to know about a SQL dialect.
 * No engine-specific `if`s exist in core - behavior differences flow
 * exclusively through this object.
 */
export interface DialectInfo {
  readonly engine: EngineKind;
  /** Grammar used by the AST guard. DuckDB parses under 'Postgresql'. */
  readonly grammar: GuardGrammar;
  /** Identifier quote character used when generating SQL hints. */
  readonly quoteChar: '"' | '`';
  /** Human-readable dialect label injected into prompts, e.g. "PostgreSQL 16". */
  readonly promptLabel: string;
  /** Pagination form the model should use. */
  readonly limitStyle: 'limit' | 'top' | 'fetch';
  /** Dialect-specific prompt hints (date functions, quoting rules, ...). */
  readonly promptNotes?: readonly string[];
}

export interface CapabilityFlags {
  readonly supportsCancel: boolean;
  readonly supportsExplain: boolean;
  readonly supportsSchemas: boolean;
  /** True when the connector enforces a read-only session at the DB level. */
  readonly readOnlySession: boolean;
  readonly supportsMatViews: boolean;
  readonly supportsTriggers: boolean;
  readonly supportsRoutines: boolean;
}

// ---------------------------------------------------------------------------
// Schema catalog - the generic-SQL-client object model
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  readonly name: string;
  readonly dbType: string;
  readonly nullable: boolean;
  readonly default?: string | null;
  readonly generated?: boolean;
  readonly comment?: string | null;
  /** Populated for enum-typed columns so WHERE literals use real values. */
  readonly enumValues?: readonly string[];
  /**
   * Distinct values observed in a low-cardinality text column that is NOT a
   * declared enum (e.g. a `status VARCHAR` that only ever holds a handful of
   * codes). Unlike enumValues these are DATA, not schema, so a connector only
   * fills them when value sampling is explicitly enabled.
   */
  readonly sampledValues?: readonly string[];
}

/**
 * A sampled text column is only useful (and only safe to surface) when it holds
 * a small, fixed set of short codes. Connectors attach `sampledValues` only when
 * the distinct count is at or below this cap; the catalog renders at most this
 * many either way.
 */
export const VALUE_SAMPLE_MAX_DISTINCT = 24;

export interface ForeignKeyInfo {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly refSchema?: string;
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

export interface IndexInfo {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly method?: string;
  /** Partial-index predicate, when present. */
  readonly predicate?: string | null;
  readonly definition?: string | null;
}

export interface TriggerInfo {
  readonly name: string;
  readonly schema?: string;
  readonly table: string;
  readonly timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF' | 'UNKNOWN';
  readonly events: readonly string[];
  readonly enabled: boolean;
  readonly definition?: string | null;
}

export interface RoutineInfo {
  readonly schema?: string;
  readonly name: string;
  readonly kind: 'function' | 'procedure';
  readonly args: string;
  readonly returns?: string | null;
  readonly language?: string | null;
  /**
   * Only 'immutable' / 'stable' routines are ever callable in generated SQL
   *. 'volatile' / 'unknown' are listed for the schema browser
   * but excluded from the prompt's callable set.
   */
  readonly volatility: 'immutable' | 'stable' | 'volatile' | 'unknown';
  readonly securityDefiner?: boolean;
  readonly source?: string | null;
}

export interface TableInfo {
  readonly schema?: string;
  readonly name: string;
  readonly kind: 'table' | 'view' | 'materialized_view';
  readonly columns: readonly ColumnInfo[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
  readonly uniques: readonly (readonly string[])[];
  readonly checks: readonly string[];
  readonly indexes: readonly IndexInfo[];
  readonly comment?: string | null;
  readonly rowEstimate?: number | null;
  readonly isPartitioned?: boolean;
  /** Parent table when this relation is a partition (collapsed by default). */
  readonly partitionOf?: string | null;
  /** View / matview definition SQL (read-only DDL display). */
  readonly definition?: string | null;
  /** 'file' for tables created from uploads (DuckDB), 'db' otherwise. */
  readonly source?: 'db' | 'file';
}

export interface EnumTypeInfo {
  readonly schema?: string;
  readonly name: string;
  readonly values: readonly string[];
}

export interface SequenceInfo {
  readonly schema?: string;
  readonly name: string;
  readonly ownedBy?: string | null;
}

export interface SchemaCatalog {
  readonly engine: EngineKind;
  readonly schemas: readonly string[];
  readonly tables: readonly TableInfo[];
  readonly enums: readonly EnumTypeInfo[];
  readonly sequences: readonly SequenceInfo[];
  readonly triggers: readonly TriggerInfo[];
  readonly routines: readonly RoutineInfo[];
  readonly extensions?: readonly string[];
  /** Permission problems, skipped objects, ... - surfaced, never fatal. */
  readonly warnings: readonly string[];
  readonly fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ColumnKind =
  | 'text'
  | 'number'
  | 'bigint'
  | 'decimal'
  | 'boolean'
  | 'timestamp'
  | 'date'
  | 'json'
  | 'binary'
  | 'unknown';

export interface ResultColumn {
  readonly name: string;
  readonly dbType?: string;
  readonly kind: ColumnKind;
}

/**
 * JSON-safe cell values. Numeric fidelity rule: BIGINT / DECIMAL /
 * NUMERIC travel as strings; JS `number` never touches them. Binary values
 * are size + hex preview only.
 */
export type CellValue =
  | string
  | number
  | boolean
  | null
  | { readonly __binary: { readonly bytes: number; readonly hexPreview: string } };

export interface ResultSet {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly (readonly CellValue[])[];
  readonly rowCount: number;
  /** True when maxRows clipped the result (DB_TOO_MANY_ROWS is a banner, not an error). */
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly warnings: readonly string[];
}

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
}

// ---------------------------------------------------------------------------
// Connector plugin interface
// ---------------------------------------------------------------------------

export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly engine: EngineKind;
  /** The connected database / file name, for display (disambiguates same-engine connections). */
  readonly database?: string;
  readonly dialect: DialectInfo;
  readonly capabilities: CapabilityFlags;
  connect(): Promise<void>;
  close(): Promise<void>;
  introspect(): Promise<SchemaCatalog>;
  execute(sql: string, opts?: ExecuteOptions): Promise<ResultSet>;
  explain?(sql: string, opts?: ExecuteOptions): Promise<ResultSet>;
}

// ---------------------------------------------------------------------------
// Guard policy
// ---------------------------------------------------------------------------

export interface GuardPolicy {
  /** v1 supports read-only exclusively; the floor is immovable. */
  readonly mode: 'read-only';
  /** Row cap injected as LIMIT when missing / lowered when higher. */
  readonly maxRows: number;
  /** Extra function names to deny on top of the per-dialect denylist. */
  readonly denyFunctions: readonly string[];
  /**
   * Whether file-reading table functions (read_csv, read_parquet, ...) are
   * allowed. True only for browser-sandboxed DuckDB; server mode denies.
   */
  readonly allowFileFunctions: boolean;
  readonly maxSqlLength: number;
  readonly maxDepth: number;
}

export interface GuardVerdict {
  readonly allowed: boolean;
  /** Possibly rewritten SQL (auto-LIMIT). Only meaningful when allowed. */
  readonly sql: string;
  /** Stable machine reason, e.g. 'statement_not_allowed:delete'. */
  readonly ruleId?: string;
  /** Plain-language reason for the user. */
  readonly reason?: string;
  readonly warnings: readonly string[];
  readonly autoLimited: boolean;
  readonly loweredLimit: boolean;
  /**
   * Base relations referenced by the (allowed) statement, in node-sql-parser
   * `type::schema::table` form - computed during the guard's single parse so
   * callers can validate against the catalog without re-parsing.
   */
  readonly tables?: readonly string[];
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly connectionId: string;
  /** Owning user in multi-user (server) mode. Absent for single-user surfaces. */
  readonly userId?: string;
  readonly question?: string;
  readonly sql: string;
  readonly status: 'ok' | 'blocked' | 'error';
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly rowCount?: number;
  readonly tokens?: { readonly input?: number; readonly output?: number };
}

export interface HistoryPage {
  readonly items: readonly HistoryEntry[];
  readonly total: number;
}

export interface HistoryStore {
  add(entry: HistoryEntry): Promise<void>;
  list(
    connectionId: string,
    opts?: { limit?: number; offset?: number; userId?: string },
  ): Promise<HistoryPage>;
}

// ---------------------------------------------------------------------------
// Semantic glossary + few-shot feedback
// ---------------------------------------------------------------------------

/** Business term -> meaning, merged into the prompt to ground vocabulary. */
export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}

export interface FewShotExample {
  readonly question: string;
  readonly sql: string;
}

/**
 * Stores question->SQL pairs a user approved (👍) and retrieves the most
 * relevant ones for a new question, scoped per connection. The
 * engine forwards retrieved examples into the prompt as few-shots.
 */
export interface FewShotStore {
  add(connectionId: string, example: FewShotExample): Promise<void>;
  retrieve(connectionId: string, question: string, limit: number): Promise<readonly FewShotExample[]>;
}

// ---------------------------------------------------------------------------
// LLM model plumbing
// ---------------------------------------------------------------------------

/** Request handed to a {@link CustomModel}. */
export interface CustomModelRequest {
  readonly system: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

/**
 * Escape hatch for custom gateways and tests: any async function that maps
 * a prompt to text (or a stream of text chunks). The public path is an AI
 * SDK {@link LanguageModel}.
 */
export type CustomModel = (
  req: CustomModelRequest,
) => Promise<string | AsyncIterable<string>>;

export type ModelLike = LanguageModel | CustomModel;

export interface LlmSettings {
  /** Overall per-call ceiling. Default 60_000. */
  readonly timeoutMs?: number;
  /** Bounded retries for 429/5xx/network faults. Default 2. */
  readonly maxRetries?: number;
  readonly maxOutputTokens?: number;
  /** Sampling temperature. Default 0 (deterministic - best for SQL). */
  readonly temperature?: number;
  /** Nucleus sampling. Prefer either temperature OR topP, not both. */
  readonly topP?: number;
  /** Top-k sampling (supported by some providers, e.g. Anthropic/Google). */
  readonly topK?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  /** Deterministic seed where the provider supports it. */
  readonly seed?: number;
  readonly stopSequences?: readonly string[];
  /**
   * Provider-specific options passed straight through to the AI SDK
   * (`providerOptions`), e.g. reasoning effort / thinking budget. Escape hatch
   * for knobs the typed fields don't cover.
   */
  readonly providerOptions?: Record<string, Record<string, unknown>>;
}

/** Host overrides for the generated prompts. */
export interface PromptSettings {
  /**
   * Replace the entire system prompt. Receives the resolved dialect label and
   * the row cap. Return your own instructions - you own correctness/safety
   * guidance if you override this (the AST guard still enforces read-only).
   */
  readonly system?: (ctx: { dialectLabel: string; maxRows: number }) => string;
  /** Extra instructions appended to the default system prompt (common case). */
  readonly instructions?: string;
}

export interface LlmUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

// ---------------------------------------------------------------------------
// Engine events (observability - every stage emits, UIs stream)
// ---------------------------------------------------------------------------

export type EngineEvent =
  | { readonly type: 'stage'; readonly stage: EngineStage; readonly detail?: string }
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'warning'; readonly message: string };

export type EngineStage =
  | 'catalog'
  | 'prune'
  | 'prompt'
  | 'llm'
  | 'extract'
  | 'guard'
  | 'repair'
  | 'execute'
  | 'done';

// ---------------------------------------------------------------------------
// Engine configuration & results
// ---------------------------------------------------------------------------

export interface PrunerSettings {
  /** Max tables included in the prompt after pruning. Default 40. */
  readonly maxTables?: number;
  /** Approximate prompt-token budget for the schema section. Default 6000. */
  readonly maxSchemaTokens?: number;
}

export interface AskSqlConfig {
  readonly connectors: readonly Connector[];
  readonly model: ModelLike;
  readonly policy?: Partial<GuardPolicy>;
  readonly history?: HistoryStore;
  readonly llm?: LlmSettings;
  readonly pruner?: PrunerSettings;
  /** Host overrides for the generated prompts. */
  readonly prompts?: PromptSettings;
  /** Business glossary merged into every prompt. */
  readonly glossary?: readonly GlossaryEntry[];
  /** Few-shot store for the approve-to-learn feedback loop. */
  readonly fewShots?: FewShotStore;
  /**
   * Schema-only prompting is the default. Opting in allows sampled
   * cell values in repair prompts. Never enable for regulated data.
   */
  readonly allowDataInPrompt?: boolean;
  readonly onEvent?: (event: EngineEvent) => void;
}

export interface AskOptions {
  readonly connectionId?: string;
  readonly signal?: AbortSignal;
  /** Prior turns for follow-up questions. */
  readonly context?: readonly { question: string; sql: string }[];
  /** Owning user, recorded on every history row this ask writes (server mode). */
  readonly userId?: string;
  readonly onEvent?: (event: EngineEvent) => void;
}

export interface AskResult {
  readonly sql: string;
  readonly explanation: string;
  readonly guard: GuardVerdict;
  readonly connectionId: string;
  readonly usage: LlmUsage;
  /** Number of repair-loop attempts consumed (0 = first shot passed). */
  readonly repairs: number;
  /** Execute the approved SQL through the guard + connector. */
  run(opts?: ExecuteOptions): Promise<ResultSet>;
}
