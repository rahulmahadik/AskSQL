/**
 * The AskSQL security boundary.
 *
 * Deterministic, AST-based, fail-closed. The LLM is untrusted input; this
 * module - not the prompt - decides what may execute. Design rules:
 *
 * - Anything unparseable under the connector's grammar is BLOCKED
 * (fail-closed), never waved through.
 * - Statement allowlist: a single SELECT (CTEs included, recursively
 * verified), EXPLAIN of a guarded SELECT, a small read-only PRAGMA /
 * SHOW allowlist per dialect.
 * - Per-dialect dangerous-function denylist + host extensions (policy may
 * only tighten - the read-only floor is immovable).
 * - Auto-LIMIT injection / lowering happens here so every caller
 * gets the same capped SQL.
 */

import pkg from 'node-sql-parser';
import { AskSqlError } from './errors.js';
import { hasMultipleStatements, stripCommentsAndStrings } from './strip.js';
import type { DialectInfo, GuardPolicy, GuardVerdict } from './types.js';

const { Parser } = pkg;
const parser = new Parser();

export const DEFAULT_GUARD_POLICY: GuardPolicy = Object.freeze({
  mode: 'read-only',
  maxRows: 1000,
  denyFunctions: Object.freeze([]) as readonly string[],
  allowFileFunctions: false,
  maxSqlLength: 100_000,
  // Generic walk-depth (objects + arrays), not statement nesting: long AND
  // chains legitimately reach ~200. 400 still blocks pathological nesting.
  maxDepth: 400,
});

/** Statement `type` values that are always write/DDL/side-effectful. */
const WRITE_TYPES = new Set([
  'insert', 'update', 'delete', 'replace', 'merge',
  'create', 'drop', 'alter', 'truncate', 'rename',
  'use', 'set', 'lock', 'unlock', 'call', 'grant', 'revoke', 'deny',
  'comment', 'analyze', 'attach', 'detach', 'copy', 'vacuum', 'reindex',
  'pragma', 'do', 'execute', 'prepare', 'deallocate', 'declare',
  'begin', 'start', 'commit', 'rollback', 'savepoint', 'transaction',
  'load', 'install', 'import', 'export', 'backup', 'restore', 'checkpoint',
  'refresh', 'cluster', 'listen', 'notify', 'discard', 'reset', 'security',
]);

const PG_DENY_FUNCTIONS = [
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'pg_rotate_logfile', 'pg_switch_wal', 'pg_promote', 'pg_create_restore_point',
  'pg_logical_emit_message', 'pg_notify', 'set_config',
  'dblink', 'dblink_exec', 'dblink_connect', 'dblink_send_query',
  'lo_import', 'lo_export',
  'pg_advisory_lock', 'pg_advisory_lock_shared', 'pg_advisory_xact_lock',
  'pg_advisory_xact_lock_shared', 'pg_try_advisory_lock',
  // Sequence mutations: read-only on Postgres/MySQL/SQLite via their read-only
  // session, but DuckDB relies solely on the guard, so deny them universally.
  'nextval', 'setval',
];

const MYSQL_DENY_FUNCTIONS = [
  'load_file', 'sleep', 'benchmark', 'get_lock', 'release_lock',
  'release_all_locks', 'master_pos_wait', 'source_pos_wait',
  'sys_exec', 'sys_eval',
];

const SQLITE_DENY_FUNCTIONS = [
  'load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer',
];

const DUCKDB_DENY_ALWAYS = ['getenv'];

/** File-reading table functions - denied unless policy.allowFileFunctions. */
const DUCKDB_FILE_FUNCTIONS = [
  'read_csv', 'read_csv_auto', 'sniff_csv', 'read_parquet', 'parquet_scan',
  'read_json', 'read_json_auto', 'read_json_objects', 'read_ndjson',
  'read_ndjson_auto', 'read_text', 'read_blob', 'read_xlsx', 'st_read', 'glob',
  // Parquet metadata readers also take a file path and disclose file contents
  // (per-row-group min/max statistics) + probe the filesystem.
  'parquet_metadata', 'parquet_schema', 'parquet_file_metadata', 'parquet_kv_metadata',
  'read_json_objects_auto', 'read_ndjson_objects',
];

/**
 * Defense in depth: block EVERY known-dangerous function on EVERY dialect,
 * not only its native one. A name like `pg_read_file` or `load_file` is
 * never a legitimate user UDF, so denying it cross-dialect costs nothing and
 * closes the "dangerous in dialect A, allowed in dialect B" gap a fuzz pass
 * surfaces. Engine-specific extras (DuckDB file readers) layer on top.
 */
const UNIVERSAL_DENY: readonly string[] = [
  ...PG_DENY_FUNCTIONS,
  ...MYSQL_DENY_FUNCTIONS,
  ...SQLITE_DENY_FUNCTIONS,
  ...DUCKDB_DENY_ALWAYS,
];

const ENGINE_DENY: Record<string, readonly string[]> = {
  postgres: UNIVERSAL_DENY,
  mysql: UNIVERSAL_DENY,
  sqlite: UNIVERSAL_DENY,
  duckdb: UNIVERSAL_DENY,
};

/**
 * Precomputed lowercase deny-sets for the DEFAULT policy (no host-added deny
 * functions, file functions denied) per engine. The base lists are already
 * lowercase literals, so this avoids rebuilding a Set and re-lowercasing
 * ~50 entries on every guard call (guardSql runs 1-3× per ask).
 */
const DEFAULT_DENY_SETS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  ['postgres', 'mysql', 'sqlite', 'duckdb'].map((engine) => [
      engine,
      new Set<string>([
          ...(ENGINE_DENY[engine] ?? []),
          ...(engine === 'duckdb' ? DUCKDB_FILE_FUNCTIONS : []),
  ]),
]),
);

const SQLITE_PRAGMA_READ_ALLOWLIST = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info',
  'index_xinfo', 'foreign_key_list', 'database_list', 'function_list',
  'collation_list', 'compile_options',
]);

const MYSQL_SHOW_ALLOW =
  /^\s*show\s+(full\s+)?(tables|databases|schemas|columns|fields|index|indexes|keys|create\s+table|create\s+view|table\s+status|triggers|events|open\s+tables|status|variables|character\s+set|collation|engines|warnings|errors)\b/i;

function blocked(sql: string, ruleId: string, reason: string): GuardVerdict {
  return {
    allowed: false,
    sql,
    ruleId,
    reason,
    warnings: [],
    autoLimited: false,
    loweredLimit: false,
  };
}

interface WalkContext {
  readonly denySet: ReadonlySet<string>;
  readonly maxDepth: number;
  violation?: { ruleId: string; reason: string };
}

/**
 * True when a relation name is actually a filesystem path, a URL, or a bare
 * data-file name - all of which DuckDB's replacement scan would read as a
 * file. A bare `'data.csv'` (no separator) is read from the working directory,
 * so a trailing data-file extension is blocked too. Registered file views are
 * named without an extension, so legitimate file analytics is unaffected.
 */
function looksLikeFileOrUrl(name: string): boolean {
  return (
    /[/\\]/.test(name) || // path separators (POSIX or Windows)
    /^[a-z][a-z0-9+.-]*:\/\//i.test(name) || // scheme:// (http, s3, file, ...)
    /^~/.test(name) || // home dir
    /^[a-zA-Z]:[\\/]/.test(name) || // Windows drive letter
    /\.(csv|tsv|txt|parquet|json|ndjson|jsonl|xlsx|xls|arrow|avro|orc|feather|db|duckdb|sqlite)$/i.test(name) // bare data file
);
}

function functionNameOf(node: Record<string, unknown>): string | null {
  const raw = node['name'];
  if (typeof raw === 'string') return raw.toLowerCase();
  if (raw && typeof raw === 'object') {
    // v5 shape: { name: [{ type: 'default', value: 'pg_sleep' }], schema? }
    const obj = raw as Record<string, unknown>;
    const arr = Array.isArray(obj['name']) ? (obj['name'] as unknown[]) : null;
    if (arr) {
      const parts = arr
        .map((p) => (p && typeof p === 'object' ? String((p as Record<string, unknown>)['value'] ?? '') : String(p)))
        .filter(Boolean);
      if (parts.length > 0) return parts.join('.').toLowerCase();
    }
    if (typeof obj['value'] === 'string') return (obj['value'] as string).toLowerCase();
  }
  return null;
}

/**
 * Generic deep walk. Robust across grammar shape differences: any nested
 * object with a write-family `type` is a violation wherever it hides
 * (CTE body, subquery, set-op branch, lateral join, scalar expression).
 */
function walk(value: unknown, ctx: WalkContext, depth: number): void {
  if (ctx.violation) return;
  if (depth > ctx.maxDepth) {
    ctx.violation = {
      ruleId: 'too_deep',
      reason: 'The statement is nested too deeply to verify safely.',
    };
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, ctx, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  const type = typeof node['type'] === 'string' ? (node['type'] as string).toLowerCase() : null;

  if (type && WRITE_TYPES.has(type)) {
    ctx.violation = {
      ruleId: `statement_not_allowed:${type}`,
      reason: `Only read-only SELECT statements are allowed (found ${type.toUpperCase()}).`,
    };
    return;
  }

  if (type === 'select') {
    // SELECT... INTO <relation> creates a table - not read-only.
    const into = node['into'] as Record<string, unknown> | null | undefined;
    if (into && typeof into === 'object') {
      const position = into['position'];
      const expr = into['expr'];
      if ((position !== null && position !== undefined) || (expr !== null && expr !== undefined)) {
        ctx.violation = {
          ruleId: 'select_into',
          reason: 'SELECT INTO creates a new table and is not allowed in read-only mode.',
        };
        return;
      }
    }
  }

// A relation whose name is a file path or URL - DuckDB's replacement scan
// reads a bare `FROM '/etc/passwd.csv'` (or `FROM 'http://...'`) as a file,
// with no function node for the denylist to catch. Legitimate table names
// never contain path separators, a URL scheme, a leading ~, or a drive
// letter, so blocking these closes the file-read/SSRF surface for every
// dialect. (Registered file views are referenced by their table name, so
// legitimate file analytics is unaffected.)
const tableRef = node['table'];
if (typeof tableRef === 'string' && looksLikeFileOrUrl(tableRef)) {
  ctx.violation = {
    ruleId: 'file_relation',
    reason: 'Reading a file or URL directly in a query is not allowed. Query registered tables by name.',
};
return;
}

  if (type === 'function' || type === 'aggr_func' || type === 'method' || type === 'tablefunc') {
    const name = functionNameOf(node);
    if (name) {
      const last = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
      if (ctx.denySet.has(name) || ctx.denySet.has(last)) {
        ctx.violation = {
          ruleId: `function_denied:${last}`,
          reason: `The function ${last} is not allowed.`,
        };
        return;
      }
    }
  }

  for (const key of Object.keys(node)) {
    walk(node[key], ctx, depth + 1);
    if (ctx.violation) return;
  }
}

interface LimitValueNode {
  type: string;
  value: number;
}

interface LimitNode {
  seperator: string;
  value: LimitValueNode[];
}

type LimitStatus =
  | { kind: 'none' }
  | { kind: 'ok' }
  | { kind: 'nonliteral' }
  | { kind: 'high'; lower: () => void };

/**
 * Inspect (without mutating) the row limit on the effective final SELECT.
 * A `high` result carries a `lower` that mutates the AST so the caller
 * can sqlify a lowered copy - used only for the rare too-high case.
 */
function inspectLimit(ast: Record<string, unknown>, maxRows: number): LimitStatus {
  let target = ast;
  while (target['_next'] && typeof target['_next'] === 'object') {
    target = target['_next'] as Record<string, unknown>;
  }
  const existing = target['limit'] as LimitNode | null | undefined;
  if (!existing || !Array.isArray(existing.value) || existing.value.length === 0) {
    return { kind: 'none' };
  }
  // MySQL `LIMIT offset, count` -> count is value[1]; else value[0].
  const countIndex = existing.seperator === ',' && existing.value.length === 2 ? 1 : 0;
  const countNode = existing.value[countIndex];
  if (!countNode || countNode.type !== 'number' || typeof countNode.value !== 'number') {
    return { kind: 'nonliteral' };
  }
  if (countNode.value > maxRows) {
    return { kind: 'high', lower: () => { countNode.value = maxRows; } };
  }
  return { kind: 'ok' };
}

export interface GuardInput {
  readonly sql: string;
  readonly dialect: DialectInfo;
  readonly policy?: Partial<GuardPolicy>;
}

export function resolveGuardPolicy(partial?: Partial<GuardPolicy>): GuardPolicy {
  const merged: GuardPolicy = {
    ...DEFAULT_GUARD_POLICY,
    ...partial,
    mode: 'read-only',
    denyFunctions: [
      ...DEFAULT_GUARD_POLICY.denyFunctions,
      ...(partial?.denyFunctions ?? []),
    ],
  };
  if ((partial as { mode?: string } | undefined)?.mode && partial?.mode !== 'read-only') {
    throw new AskSqlError('CONFIG_ERROR', {
        detail: `GuardPolicy.mode '${String(partial?.mode)}' is not supported - the read-only floor is immovable in v1.`,
      userMessage: 'AskSQL is misconfigured: only read-only mode is supported.',
    });
  }
  return merged;
}

/**
 * Validate (and possibly rewrite) one SQL statement. Never throws for
 * disallowed SQL - returns a verdict; throws only on misconfiguration.
 */
export function guardSql(input: GuardInput): GuardVerdict {
  const policy = resolveGuardPolicy(input.policy);
  const { dialect } = input;
  const original = input.sql ?? '';
  const trimmed = original.trim();

  if (trimmed.length === 0) {
    return blocked(original, 'empty', 'The statement is empty.');
  }
  if (trimmed.length > policy.maxSqlLength) {
    return blocked(original, 'too_long', 'The statement is too long to verify safely.');
  }

  const stripped = stripCommentsAndStrings(trimmed);
  if (hasMultipleStatements(stripped)) {
    return blocked(original, 'multi_statement', 'Only a single statement is allowed.');
  }
  const strippedTrim = stripped.trim().replace(/;\s*$/u, '');
  const body = trimmed.replace(/;\s*$/u, '');

  // ---- Dialect-specific allowlisted read commands (checked pre-parser) ----
  if (dialect.engine === 'sqlite' && /^\s*pragma\b/iu.test(strippedTrim)) {
    const m = /^\s*pragma\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*([A-Za-z0-9_."'`]+)\s*\))?\s*$/iu.exec(body);
    if (m && SQLITE_PRAGMA_READ_ALLOWLIST.has(m[1]!.toLowerCase())) {
      return {
        allowed: true, sql: body, warnings: [], autoLimited: false, loweredLimit: false,
      };
    }
    return blocked(original, 'pragma_denied', 'Only read-only PRAGMA commands are allowed.');
  }

  if (dialect.engine === 'mysql' && /^\s*(show|desc|describe)\b/iu.test(strippedTrim)) {
    if (MYSQL_SHOW_ALLOW.test(strippedTrim)) {
      return { allowed: true, sql: body, warnings: [], autoLimited: false, loweredLimit: false };
    }
    if (/^\s*(desc|describe)\s+[A-Za-z0-9_.`"]+\s*$/iu.test(body)) {
      return { allowed: true, sql: body, warnings: [], autoLimited: false, loweredLimit: false };
    }
    return blocked(original, 'show_denied', 'Only read-only SHOW/DESCRIBE commands are allowed.');
  }

  // ---- EXPLAIN wrapper: guard the inner statement, keep the prefix ----
  let inner = body;
  let explainPrefix = '';
  const explainMatch =
    /^\s*explain(\s+query\s+plan|\s+analyze|\s+verbose|\s*\([^)]*\))*\s+/iu.exec(body);
  if (explainMatch) {
    explainPrefix = body.slice(0, explainMatch[0].length);
    inner = body.slice(explainMatch[0].length);
    // EXPLAIN ANALYZE executes its target, but the inner statement is verified
    // as a guarded SELECT below via the normal path, so no special handling.
  }

  // ---- Lexical read-only floor (belt for shapes the AST may not expose) ----
  const strippedInner = stripCommentsAndStrings(inner);
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/iu.test(strippedInner)) {
    return blocked(original, 'locking_clause', 'Row-locking clauses (FOR UPDATE/SHARE) are not allowed.');
  }
  if (/\binto\s+(outfile|dumpfile)\b/iu.test(strippedInner)) {
    return blocked(original, 'into_outfile', 'Writing query output to files is not allowed.');
  }

// ---- Parse ONCE (fail-closed). `parse` yields the AST and the table
// list together, so the engine's hallucination check can reuse the list
// instead of re-parsing the same SQL. ----
  let ast: unknown;
  let tableList: string[] = [];
  try {
    const parsed = parser.parse(inner, { database: dialect.grammar });
    ast = parsed.ast;
    tableList = Array.isArray(parsed.tableList) ? parsed.tableList : [];
  } catch (err) {
    return blocked(
      original,
      'parse_failed',
      'The statement could not be verified as safe SQL for this database, so it was blocked.',
    );
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return blocked(original, 'multi_statement', 'Only a single statement is allowed.');
  }
  const root = statements[0] as Record<string, unknown>;
  const rootType = typeof root['type'] === 'string' ? (root['type'] as string).toLowerCase() : '';
  if (rootType !== 'select') {
    return blocked(
      original,
      `statement_not_allowed:${rootType || 'unknown'}`,
      `Only read-only SELECT statements are allowed (found ${rootType.toUpperCase() || 'UNKNOWN'}).`,
    );
  }

  // ---- Deep walk: CTE bodies, subqueries, set-ops, expressions ----
  // Reuse the precomputed default set unless the host added deny functions or
  // opted into file functions (the only cases that change the set).
  const denySet: ReadonlySet<string> =
  policy.denyFunctions.length === 0 && !policy.allowFileFunctions
  ? DEFAULT_DENY_SETS[dialect.engine] ?? new Set<string>()
  : new Set<string>(
    [
      ...(ENGINE_DENY[dialect.engine] ?? []),
      ...(dialect.engine === 'duckdb' && !policy.allowFileFunctions ? DUCKDB_FILE_FUNCTIONS : []),
      ...policy.denyFunctions,
    ].map((f) => f.toLowerCase()),
  );
  const ctx: WalkContext = { denySet, maxDepth: policy.maxDepth };
  walk(root, ctx, 0);
  if (ctx.violation) {
    return blocked(original, ctx.violation.ruleId, ctx.violation.reason);
  }

  // ---- Row cap (skip under EXPLAIN - plans don't return rows) ----
  const warnings: string[] = [];
  let autoLimited = false;
  let loweredLimit = false;
  let finalSql = body;
  if (!explainPrefix) {
    const status = inspectLimit(root, policy.maxRows);
    if (status.kind === 'none') {
      // Textual append preserves the model's exact formatting (the "show
      // query" surface stays faithful) - the guard already proved this is a
      // single SELECT, so a trailing LIMIT binds correctly (incl. set-ops).
      // The LIMIT goes on its OWN line so a trailing `--`/`#` line comment in
      // `body` can't comment it out (which would leave an unbounded scan while
      // still reporting autoLimited=true).
      finalSql = `${body}\nLIMIT ${policy.maxRows}`;
      autoLimited = true;
    } else if (status.kind === 'high') {
      // Rewriting an existing numeric LIMIT safely requires re-serialization.
      status.lower();
      try {
        finalSql = parser.sqlify(root as never, { database: dialect.grammar });
        loweredLimit = true;
      } catch {
        // Keep original; the connector-level maxRows slice is the backstop.
        finalSql = body;
        warnings.push('The row limit is higher than allowed; it is enforced at execution time.');
      }
    } else if (status.kind === 'nonliteral') {
      warnings.push('Row limit uses a non-literal value; the row cap is enforced at execution time instead.');
    }
  } else {
    finalSql = explainPrefix + inner;
  }

return { allowed: true, sql: finalSql, warnings, autoLimited, loweredLimit, tables: tableList };
}
