/**
 * The AskSQL security boundary: deterministic, AST-based, fail-closed. Unparseable input is
 * blocked. Allowlist: a single SELECT (CTEs verified recursively), EXPLAIN of a guarded SELECT,
 * and read-only PRAGMA/SHOW per dialect. Per-dialect dangerous-function denylist that policy may
 * only tighten, plus auto-LIMIT injection/lowering.
 */

import pkg from 'node-sql-parser';
import { AskSqlError } from './errors.js';
import { hasMultipleStatements, maskCommentsAndStrings, stripCommentsAndStrings, trimTrailingNoise } from './strip.js';
import type { DialectInfo, EngineKind, GuardPolicy, GuardVerdict } from './types.js';

const { Parser } = pkg;
const parser = new Parser();

export const DEFAULT_GUARD_POLICY: GuardPolicy = Object.freeze({
  mode: 'read-only',
  maxRows: 1000,
  denyFunctions: Object.freeze([]) as readonly string[],
  allowFileFunctions: false,
  maxSqlLength: 100_000,
  // Generic walk-depth (objects + arrays), not statement nesting: long AND chains reach ~200.
  maxDepth: 400,
});

/** Statement `type` values that are always write/DDL/side-effectful. */
const WRITE_TYPES = new Set([
  'insert',
  'update',
  'delete',
  'replace',
  'merge',
  'create',
  'drop',
  'alter',
  'truncate',
  'rename',
  'use',
  'set',
  'lock',
  'unlock',
  'call',
  'grant',
  'revoke',
  'deny',
  'comment',
  'analyze',
  'attach',
  'detach',
  'copy',
  'vacuum',
  'reindex',
  'pragma',
  'do',
  'execute',
  'prepare',
  'deallocate',
  'declare',
  'begin',
  'start',
  'commit',
  'rollback',
  'savepoint',
  'transaction',
  'load',
  'install',
  'import',
  'export',
  'backup',
  'restore',
  'checkpoint',
  'refresh',
  'cluster',
  'listen',
  'notify',
  'discard',
  'reset',
  'security',
]);

const PG_DENY_FUNCTIONS = [
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_switch_wal',
  'pg_promote',
  'pg_create_restore_point',
  'pg_logical_emit_message',
  'pg_notify',
  'set_config',
  'dblink',
  'dblink_exec',
  'dblink_connect',
  'dblink_connect_u',
  'dblink_send_query',
  'dblink_open',
  'dblink_fetch',
  'dblink_close',
  'dblink_cancel_query',
  'dblink_get_result',
  // Large objects are writable server-side storage; both read and write are denied.
  'lo_import',
  'lo_export',
  'lo_put',
  'lo_from_bytea',
  'lo_unlink',
  'lo_creat',
  'lo_create',
  'lowrite',
  'loread',
  'lo_open',
  'lo_close',
  'lo_truncate',
  'lo_truncate64',
  'lo_lseek',
  'lo_lseek64',
  'lo_get',
  'lo_get_fragment',
  'lo_read',
  'pg_advisory_lock',
  'pg_advisory_lock_shared',
  'pg_advisory_xact_lock',
  'pg_advisory_xact_lock_shared',
  'pg_try_advisory_lock',
  'pg_try_advisory_lock_shared',
  'pg_try_advisory_xact_lock',
  'pg_try_advisory_xact_lock_shared',
  'pg_advisory_unlock',
  'pg_advisory_unlock_shared',
  'pg_advisory_unlock_all',
  // Replication slots and origins create/drop persistent server objects.
  'pg_create_logical_replication_slot',
  'pg_create_physical_replication_slot',
  'pg_drop_replication_slot',
  'pg_replication_origin_create',
  'pg_replication_origin_drop',
  'pg_replication_origin_session_setup',
  'pg_replication_origin_session_reset',
  'pg_replication_origin_advance',
  'pg_replication_origin_xact_setup',
  'pg_replication_origin_xact_reset',
  'pg_logical_slot_get_changes',
  'pg_logical_slot_get_binary_changes',
  // Server-state resets and snapshot side effects.
  'pg_stat_reset',
  'pg_stat_reset_shared',
  'pg_stat_reset_single_table_counters',
  'pg_stat_reset_single_function_counters',
  'pg_stat_reset_slru',
  'pg_stat_reset_replication_slot',
  'pg_export_snapshot',
  'pg_log_backend_memory_contexts',
  // Directory listing / filesystem disclosure.
  'pg_ls_logdir',
  'pg_ls_waldir',
  'pg_ls_tmpdir',
  'pg_ls_archive_statusdir',
  'pg_ls_replslotdir',
  'pg_ls_logicalsnapdir',
  'pg_ls_logicalmapdir',
  'pg_current_logfile',
  'pg_logdir_ls',
  'pg_read_server_files',
  'fsdir',
  // adminpack: arbitrary server-side file write/delete/rename - an RCE primitive.
  'pg_file_write',
  'pg_file_unlink',
  'pg_file_rename',
  'pg_file_sync',
  // Server control: backups, WAL replay, replication-slot advance, extra resets.
  'pg_start_backup',
  'pg_stop_backup',
  'pg_backup_start',
  'pg_backup_stop',
  'pg_wal_replay_pause',
  'pg_wal_replay_resume',
  'pg_replication_slot_advance',
  'pg_stat_statements_reset',
  'pg_import_system_collations',
  // Index/cache maintenance side effects.
  'gin_clean_pending_list',
  'brin_summarize_new_values',
  'brin_desummarize_range',
  'brin_summarize_range',
  'pgstattuple',
  'pgstatindex',
  'pgstatginindex',
  // Functions that execute SQL passed as a STRING: the AST walk cannot see inside a string literal.
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'table_to_xml',
  'table_to_xmlschema',
  'table_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'schema_to_xml',
  'schema_to_xmlschema',
  'schema_to_xml_and_xmlschema',
  'database_to_xml',
  'database_to_xmlschema',
  'database_to_xml_and_xmlschema',
  // Sequence mutations: DuckDB has no read-only session, so they are denied universally.
  'nextval',
  'setval',
];

const MYSQL_DENY_FUNCTIONS = [
  'load_file',
  'sleep',
  'benchmark',
  'get_lock',
  'release_lock',
  'release_all_locks',
  'master_pos_wait',
  'source_pos_wait',
  'sys_exec',
  'sys_eval',
  'wait_for_executed_gtid_set',
  'wait_until_sql_thread_after_gtids',
];

const SQLITE_DENY_FUNCTIONS = [
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'fts3_tokenizer',
  // fileio / zipfile extension siblings: file write, dir ops, arbitrary reads.
  'mkdir',
  'symlink',
  'lsdir',
  'fileio_read',
  'fileio_write',
  'zipfile',
];

const DUCKDB_DENY_ALWAYS = [
  'getenv',
  // Scanner-extension functions run SQL against, or attach, a foreign database - a write channel through a SELECT.
  'postgres_execute',
  'mysql_execute',
  'sqlite_execute',
  'postgres_query',
  'mysql_query',
  'sqlite_query',
  'postgres_scan',
  'postgres_scan_pushdown',
  'mysql_scan',
  'sqlite_scan',
  'postgres_attach',
  'mysql_attach',
  'sqlite_attach',
  'iceberg_scan',
  'iceberg_metadata',
  'iceberg_snapshots',
  'delta_scan',
  'ducklake_scan',
  // Secret store disclosure.
  'duckdb_secrets',
  'which_secret',
  // httpfs extensions make outbound requests from a SELECT: SSRF via http_get, exfiltration via http_post/put.
  'http_get',
  'http_post',
  'http_put',
  'http_delete',
  'http_head',
  'http_patch',
  'read_gsheet',
  'fsdir',
  // query()/query_table() execute a SQL string in the same connection; a wrapped read_csv reads any file.
  'query',
  'query_table',
  // Secret/credential loaders and session mutators.
  'load_aws_credentials',
  'set_current_schema',
];

/** DuckDB suffixes that are always a foreign-DB/scanner escape: `_execute`, `_query`, `_scan`, `_attach`. */
const DUCKDB_DENY_SUFFIXES = ['_execute', '_query', '_scan', '_attach'];

/** Postgres file/dir disclosure families - every member is admin-only, never a read-only analytics call. */
const PG_DENY_PREFIXES = ['pg_ls_', 'pg_read_'];

/** DuckDB prefixes that are always a file/data reader (read_csv, read_parquet, scan_arrow_ipc, ...). */
/** Oracle's row-limiting clause in every legal spelling; node-sql-parser reads none of them. */
// Anchored at the FETCH keyword: a leading \s+ would make the regex retry inside every whitespace
// run of a non-matching statement, which is quadratic (seconds of CPU at the 100k length cap).
const ORACLE_FETCH_CLAUSE = /\bFETCH\s+(?:FIRST|NEXT)\s+(?:(\d+)\s+)?(PERCENT\s+)?ROWS?\s+(?:ONLY|WITH\s+TIES)\s*$/i;
/** An `OFFSET n ROWS` ending exactly where the FETCH clause's leading whitespace starts. */
const ORACLE_OFFSET_BEFORE = /\bOFFSET\s+\d+\s+ROWS?$/i;

interface OracleFetchTail {
  /** The full tail (leading whitespace, optional OFFSET clause, FETCH clause). */
  readonly text: string;
  /** Where the tail starts in the input. */
  readonly index: number;
  /** The literal row count, or null for FETCH FIRST ROW ONLY / a PERCENT clause. */
  readonly count: number | null;
}

/** Locate the trailing OFFSET/FETCH clause, matching what a `\s+(?:OFFSET...)?FETCH...$` regex would. */
function oracleFetchTail(inner: string): OracleFetchTail | null {
  const m = ORACLE_FETCH_CLAUSE.exec(inner);
  if (!m) return null;
  // The clause must be preceded by whitespace; take the whole run, as the old leading \s+ did.
  let ws = m.index;
  while (ws > 0 && /\s/.test(inner[ws - 1]!)) ws--;
  if (ws === m.index) return null;
  let start = ws;
  // An optional `OFFSET n ROWS` directly before, itself preceded by whitespace, joins the tail.
  const off = ORACLE_OFFSET_BEFORE.exec(inner.slice(0, ws));
  if (off) {
    let ows = off.index;
    while (ows > 0 && /\s/.test(inner[ows - 1]!)) ows--;
    if (ows < off.index) start = ows;
  }
  const count = m[1] && !m[2] ? Number(m[1]) : null;
  return { text: inner.slice(start), index: start, count };
}

const DUCKDB_DENY_PREFIXES = ['read_', 'scan_'];

/** Denied only on DuckDB: current_setting discloses cloud credentials; prompt/open_prompt call out over HTTP. */
/** Settings and credential disclosure; denied regardless of allowFileFunctions, which is about files. */
const DUCKDB_ONLY_DENY = ['current_setting', 'duckdb_settings', 'prompt', 'open_prompt'];

/** File-reading table functions - denied unless policy.allowFileFunctions. */
const DUCKDB_FILE_FUNCTIONS = [
  'read_csv',
  'read_csv_auto',
  'sniff_csv',
  'read_parquet',
  'parquet_scan',
  'read_json',
  'read_json_auto',
  'read_json_objects',
  'read_ndjson',
  'read_ndjson_auto',
  'read_text',
  'read_blob',
  'read_xlsx',
  'glob',
  // Spatial readers take a file-path argument (st_read denied; siblings too).
  'st_read',
  'st_readosm',
  'st_readshp',
  'st_read_meta',
  // Parquet metadata readers take a file path and disclose file contents and filesystem layout.
  'parquet_metadata',
  'parquet_schema',
  'parquet_file_metadata',
  'parquet_kv_metadata',
  'read_json_objects_auto',
  'read_ndjson_objects',
];

// Bare SSRF constructors: build a URL type from a string and fetch it inside a SELECT.
const ORACLE_DENY_FUNCTIONS = ['httpuritype', 'dburitype', 'xdburitype'];

/** Oracle packages exposing the filesystem, network, scheduler or a SQL-string executor; matched qualified. */
const ORACLE_DENY_PREFIXES = [
  'utl_file.',
  'utl_http.',
  'utl_tcp.',
  'utl_smtp.',
  'utl_inaddr.',
  'utl_dbws.',
  'urifactory.',
  'dbms_scheduler.',
  'dbms_job.',
  'dbms_pipe.',
  'dbms_lock.',
  'dbms_java.',
  'dbms_sql.',
  'dbms_xmlquery.',
  'dbms_xmlgen.',
  'dbms_metadata.',
  'dbms_session.',
  'dbms_lob.',
  'dbms_ldap.',
  'dbms_ldap_utl.',
];

/** Oracle sequence pseudo-columns: `seq.nextval` mutates the sequence, so it is not read-only. Parsed as a column, not a function. */
const ORACLE_SEQUENCE_PSEUDO_COLUMNS = new Set(['nextval', 'currval']);

/** Every known-dangerous function is denied on every dialect, closing the "dangerous in A, allowed in B" gap. */
const UNIVERSAL_DENY: readonly string[] = [
  ...PG_DENY_FUNCTIONS,
  ...MYSQL_DENY_FUNCTIONS,
  ...SQLITE_DENY_FUNCTIONS,
  ...DUCKDB_DENY_ALWAYS,
  ...ORACLE_DENY_FUNCTIONS,
];

const ENGINE_DENY: Record<string, readonly string[]> = {
  postgres: UNIVERSAL_DENY,
  mysql: UNIVERSAL_DENY,
  sqlite: UNIVERSAL_DENY,
  duckdb: UNIVERSAL_DENY,
  oracle: UNIVERSAL_DENY,
};

/** Prefix analogue of UNIVERSAL_DENY: never real user functions, so denied on every dialect. DuckDB's read_/scan_ stay DuckDB-only (below). */
const UNIVERSAL_DENY_PREFIXES: readonly string[] = [...PG_DENY_PREFIXES, ...ORACLE_DENY_PREFIXES];

/** Precomputed lowercase deny-sets, per engine, for the DEFAULT policy. */
const DEFAULT_DENY_SETS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  ['postgres', 'mysql', 'sqlite', 'duckdb', 'oracle'].map((engine) => [
    engine,
    new Set<string>([
      ...(ENGINE_DENY[engine] ?? []),
      ...(engine === 'duckdb' ? [...DUCKDB_FILE_FUNCTIONS, ...DUCKDB_ONLY_DENY] : []),
    ]),
  ]),
);

const SQLITE_PRAGMA_READ_ALLOWLIST = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'database_list',
  'function_list',
  'collation_list',
  'compile_options',
]);

const MYSQL_SHOW_ALLOW =
  /^\s*show\s+(full\s+)?(tables|databases|schemas|columns|fields|index|indexes|keys|create\s+table|create\s+view|table\s+status|triggers|events|open\s+tables|status|variables|character\s+set|collation|engines|warnings|errors)\b/i;

/** A subquery or function call in a SHOW's WHERE/LIKE tail; the fast path cannot vet either. */
const SHOW_TAIL_EXECUTES = /\(\s*select\b|\b[a-z_][a-z0-9_]*\s*\(/i;

/** True if the SQL contains a MySQL executable comment opener (`/*!`) outside a string literal. */
function hasMysqlExecutableComment(sql: string): boolean {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    // Block comments are handled before quotes: an apostrophe inside a plain one would otherwise
    // open a string scan that runs past, and hides, a following `/*!`.
    if (c === '/' && sql[i + 1] === '*') {
      if (sql[i + 2] === '!') return true;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && quote !== '`') i += 2;
        else if (sql[i] === quote && sql[i + 1] === quote) i += 2;
        else if (sql[i] === quote) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    // Skip line comments: a `/*!` inside `-- ...` or `# ...` is not executed by MySQL.
    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    // Skip ordinary block comments so a `/*!` nested after a plain one is still found.
    if (c === '/' && sql[i + 1] === '*' && sql[i + 2] === '!') return true;
    i++;
  }
  return false;
}

/**
 * True for a SQLite recursive CTE forced to full materialization (an aggregate, DISTINCT or GROUP
 * BY) with no LIMIT: `node:sqlite` runs synchronously, so such a query never returns.
 */
function sqliteRecursiveWedge(strippedInner: string): boolean {
  if (!/\bwith\s+recursive\b/iu.test(strippedInner)) return false;
  if (/\blimit\b/iu.test(strippedInner)) return false;
  return (
    /\b(count|sum|avg|min|max|total|group_concat)\s*\(/iu.test(strippedInner) ||
    /\bgroup\s+by\b/iu.test(strippedInner) ||
    /\bselect\s+distinct\b/iu.test(strippedInner)
  );
}

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
  readonly denySuffixes: readonly string[];
  readonly denyPrefixes: readonly string[];
  readonly maxDepth: number;
  readonly engine: EngineKind;
  violation?: { ruleId: string; reason: string };
}

/** The bare column name of a column_ref node, across node-sql-parser shape variants. */
function columnNameOf(node: Record<string, unknown>): string | null {
  const col = node['column'];
  if (typeof col === 'string') return col.toLowerCase();
  if (col && typeof col === 'object') {
    const expr = (col as Record<string, unknown>)['expr'];
    if (expr && typeof expr === 'object') {
      const v = (expr as Record<string, unknown>)['value'];
      if (typeof v === 'string') return v.toLowerCase();
    }
    const v = (col as Record<string, unknown>)['value'];
    if (typeof v === 'string') return v.toLowerCase();
  }
  return null;
}

/** True when a relation name is a path, URL or bare data-file name that DuckDB would read as a file. */
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
      if (parts.length > 0) {
        // Prepend the package/schema qualifier (e.g. UTL_HTTP.REQUEST) so Oracle package prefixes match.
        const schema = obj['schema'];
        const schemaName =
          schema && typeof schema === 'object' ? String((schema as Record<string, unknown>)['value'] ?? '') : '';
        return [schemaName, ...parts].filter(Boolean).join('.').toLowerCase();
      }
    }
    if (typeof obj['value'] === 'string') return (obj['value'] as string).toLowerCase();
  }
  return null;
}

/** Generic deep walk: any nested object with a write-family `type` is a violation wherever it hides. */
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

  // A relation named like a file path or URL: DuckDB's replacement scan reads it as a file.
  const tableRef = node['table'];
  if (typeof tableRef === 'string' && looksLikeFileOrUrl(tableRef)) {
    ctx.violation = {
      ruleId: 'file_relation',
      reason: 'Reading a file or URL directly in a query is not allowed. Query registered tables by name.',
    };
    return;
  }

  // Oracle `seq.nextval` parses as a column, not a function, so the denylist never sees it.
  if (type === 'column_ref' && ctx.engine === 'oracle') {
    const col = columnNameOf(node);
    if (col && ORACLE_SEQUENCE_PSEUDO_COLUMNS.has(col)) {
      ctx.violation = {
        ruleId: `sequence_pseudo_column:${col}`,
        reason: `The sequence pseudo-column ${col} is not read-only.`,
      };
      return;
    }
  }

  if (type === 'function' || type === 'aggr_func' || type === 'method' || type === 'tablefunc') {
    const name = functionNameOf(node);
    if (name) {
      const last = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
      // Oracle package prefixes match the schema-qualified name; the others match the last segment.
      if (
        ctx.denySet.has(name) ||
        ctx.denySet.has(last) ||
        ctx.denySuffixes.some((s) => last.endsWith(s)) ||
        ctx.denyPrefixes.some((p) => name.startsWith(p) || last.startsWith(p))
      ) {
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
  // "seperator" is node-sql-parser's own (misspelled) field name, not a typo here.
  seperator: string;
  value: LimitValueNode[];
}

type LimitStatus =
  | { kind: 'none' }
  | { kind: 'ok' }
  /** `at` is the offset of the LIMIT keyword when it was located textually, so the rewrite can be anchored. */
  | { kind: 'unbounded'; at?: number }
  | { kind: 'nonliteral' }
  | { kind: 'high' };

/** Inspect (without mutating) the row limit on the effective final SELECT. */
/**
 * Replace the count in the last LIMIT clause, leaving every other character alone. Returns null
 * when the clause cannot be located textually, in which case the caller keeps the original.
 */
function lowerLimitInText(sql: string, maxRows: number, engine?: string): string | null {
  // Masked, not stripped: the offsets below index into `sql`, so lengths must match. The engine
  // matters: without it a MySQL `\'` escape desyncs the scan and hides the real LIMIT.
  const stripped = maskCommentsAndStrings(sql, engine);
  // The final LIMIT is the one that binds the result set; earlier ones sit inside subqueries.
  const re = /\blimit\s+(\d+)\s*(,\s*(\d+))?/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) last = m;
  if (!last) return null;
  // `LIMIT offset, count` puts the count second; `LIMIT n [OFFSET m]` puts it first.
  const countText = last[3] ?? last[1]!;
  const countStart = last.index + last[0].lastIndexOf(countText);
  if (Number(countText) <= maxRows) return null;
  // Fail closed rather than splice blind: the original must hold the same digits at that offset.
  if (sql.slice(countStart, countStart + countText.length) !== countText) return null;
  return sql.slice(0, countStart) + String(maxRows) + sql.slice(countStart + countText.length);
}

/**
 * The LIMIT written outside every parenthesised branch, or null when there is none. Scanned on the
 * masked text so a parenthesis inside a string or quoted identifier cannot shift the nesting depth.
 * A clause that is present but not a plain number is `nonliteral`, never null: the two mean
 * opposite things to the caller.
 */
function statementLevelLimit(
  sql: string,
  engine?: string,
): { kind: 'number'; value: number } | { kind: 'all'; at: number } | { kind: 'nonliteral' } | null {
  const masked = maskCommentsAndStrings(sql, engine);
  let depth = 0;
  let at = -1;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (ch === 'l' || ch === 'L') && /^limit\b/iu.test(masked.slice(i, i + 6))) {
      if (i === 0 || /[\s)]/u.test(masked[i - 1] ?? '')) at = i;
    }
  }
  if (at < 0) return null;
  const tail = masked.slice(at);
  if (/^limit\s+all\b/iu.test(tail)) return { kind: 'all', at };
  // MySQL's `LIMIT offset, count` puts the count second; every other form puts it first.
  const m = /^limit\s+(\d+)\s*(?:,\s*(\d+))?/iu.exec(tail);
  // A parameter or subquery count cannot be read here, and must not be mistaken for no limit at all.
  return m ? { kind: 'number', value: Number(m[2] ?? m[1]) } : { kind: 'nonliteral' };
}

function inspectLimit(ast: Record<string, unknown>, maxRows: number, sql?: string, engine?: string): LimitStatus {
  let target = ast;
  while (target['_next'] && typeof target['_next'] === 'object') {
    target = target['_next'] as Record<string, unknown>;
  }
  // A branch's LIMIT caps that branch alone, and the parser both misplaces it and drops a
  // trailing statement-level one, so the text is the only reliable source here.
  if (target !== ast && target['parentheses_symbol'] === true && sql !== undefined) {
    const statementLimit = statementLevelLimit(sql, engine);
    if (statementLimit === null) return { kind: 'none' };
    if (statementLimit.kind === 'all') return { kind: 'unbounded', at: statementLimit.at };
    if (statementLimit.kind === 'nonliteral') return { kind: 'nonliteral' };
    return statementLimit.value > maxRows ? { kind: 'high' } : { kind: 'ok' };
  }
  const existing = target['limit'] as LimitNode | null | undefined;
  if (!existing || !Array.isArray(existing.value) || existing.value.length === 0) {
    return { kind: 'none' };
  }
  // Bare `OFFSET n` is a single value with seperator 'offset': it counts as no limit and is never lowered.
  if (existing.seperator === 'offset' && existing.value.length === 1) {
    return { kind: 'none' };
  }
  // MySQL `LIMIT offset, count` -> count is value[1]; else value[0] (incl. `LIMIT n OFFSET m`).
  const countIndex = existing.seperator === ',' && existing.value.length === 2 ? 1 : 0;
  const countNode = existing.value[countIndex];
  if (countNode && countNode.type === 'origin' && String(countNode.value).toLowerCase() === 'all') {
    return { kind: 'unbounded' };
  }
  if (!countNode || countNode.type !== 'number' || typeof countNode.value !== 'number') {
    return { kind: 'nonliteral' };
  }
  if (countNode.value > maxRows) return { kind: 'high' };
  return { kind: 'ok' };
}

export interface GuardInput {
  readonly sql: string;
  readonly dialect: DialectInfo;
  readonly policy?: Partial<GuardPolicy>;
}

/** Nothing a caller asks for may exceed this; a row cap is a memory bound, not a preference. */
const MAX_ROW_CAP = 100_000;

export function resolveGuardPolicy(partial?: Partial<GuardPolicy>): GuardPolicy {
  const merged: { -readonly [K in keyof GuardPolicy]: GuardPolicy[K] } = {
    ...DEFAULT_GUARD_POLICY,
    ...partial,
    mode: 'read-only',
    denyFunctions: [...DEFAULT_GUARD_POLICY.denyFunctions, ...(partial?.denyFunctions ?? [])],
  };
  // maxRows reaches here straight from an HTTP client, so it is clamped rather than trusted:
  // a NaN or a billion would otherwise become the row cap.
  const requested = merged.maxRows;
  merged.maxRows =
    Number.isFinite(requested) && requested >= 1
      ? Math.min(Math.floor(requested), MAX_ROW_CAP)
      : DEFAULT_GUARD_POLICY.maxRows;
  if ((partial as { mode?: string } | undefined)?.mode && partial?.mode !== 'read-only') {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: `GuardPolicy.mode '${String(partial?.mode)}' is not supported - the read-only floor is immovable in v1.`,
      userMessage: 'AskSQL is misconfigured: only read-only mode is supported.',
    });
  }
  return merged;
}

/** Validate (and possibly rewrite) one SQL statement; returns a verdict, throws only on misconfiguration. */
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

  // MySQL executes the body of `/*! ... */` comments, but the stripper and parser delete it unseen.
  if (dialect.engine === 'mysql' && hasMysqlExecutableComment(trimmed)) {
    return blocked(original, 'mysql_executable_comment', 'MySQL executable comments (/*! ... */) are not allowed.');
  }

  const stripped = stripCommentsAndStrings(trimmed, dialect.engine);
  if (hasMultipleStatements(stripped)) {
    return blocked(original, 'multi_statement', 'Only a single statement is allowed.');
  }
  const strippedTrim = stripped.trim().replace(/;\s*$/u, '');
  // Strip trailing `;`, whitespace and comments so the appended auto-LIMIT binds to the statement.
  const body = trimTrailingNoise(trimmed, dialect.engine);

  // ---- Dialect-specific allowlisted read commands (checked pre-parser) ----
  if (dialect.engine === 'sqlite' && /^\s*pragma\b/iu.test(strippedTrim)) {
    const m = /^\s*pragma\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*([A-Za-z0-9_."'`]+)\s*\))?\s*$/iu.exec(body);
    if (m && SQLITE_PRAGMA_READ_ALLOWLIST.has(m[1]!.toLowerCase())) {
      return {
        allowed: true,
        sql: body,
        warnings: [],
        autoLimited: false,
        loweredLimit: false,
      };
    }
    return blocked(original, 'pragma_denied', 'Only read-only PRAGMA commands are allowed.');
  }

  if (dialect.engine === 'mysql' && /^\s*(show|desc|describe)\b/iu.test(strippedTrim)) {
    // A SHOW may carry a WHERE/LIKE tail, and an expression there runs like any other. Only the
    // shapes the parser cannot help with are allowed, and only without a subquery or function call.
    if (SHOW_TAIL_EXECUTES.test(strippedTrim)) {
      return blocked(
        original,
        'show_expression',
        'A SHOW command may not carry a subquery or function call. Use a plain SHOW, or a SELECT against information_schema.',
      );
    }
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
  // Valid Oracle syntax the parser cannot read: strip the trailing clause, validate, re-apply it.
  let fetchTailText: string | null = null;
  let strippedFetchLimit: number | null = null;
  if (dialect.limitStyle === 'fetch') {
    // This dialect has no LIMIT. Refusing it here sends the query back to be rewritten, instead of
    // letting the database reject it (ORA-03049) after the repair loop has already finished.
    const strayLimit = /\blimit\s+(?:\d+|:\w+|\?)\s*(?:offset\s+\d+\s*)?;?\s*$/iu.exec(
      stripCommentsAndStrings(inner, dialect.engine),
    );
    if (strayLimit) {
      return blocked(
        original,
        'limit_unsupported',
        `${dialect.promptLabel} has no LIMIT clause. Remove it and order the results instead; the row cap is applied when the query runs.`,
      );
    }
    const fetchTail = oracleFetchTail(inner);
    if (fetchTail) {
      fetchTailText = fetchTail.text;
      // `FETCH FIRST ROW ONLY` and a PERCENT clause carry no row count to lower.
      strippedFetchLimit = fetchTail.count;
      inner = inner.slice(0, fetchTail.index);
    }
  }
  let explainPrefix = '';
  const explainMatch = /^\s*explain(\s+query\s+plan|\s+analyze|\s+verbose|\s*\([^)]*\))*\s+/iu.exec(body);
  if (explainMatch) {
    explainPrefix = body.slice(0, explainMatch[0].length);
    inner = body.slice(explainMatch[0].length);
    // EXPLAIN ANALYZE executes its target; the inner statement is verified as a guarded SELECT below.
  }

  // ---- Lexical read-only floor (belt for shapes the AST may not expose) ----
  const strippedInner = stripCommentsAndStrings(inner, dialect.engine);
  // MySQL's `LOCK IN SHARE MODE` takes the same row locks as `FOR SHARE`.
  if (
    /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/iu.test(strippedInner) ||
    /\block\s+in\s+share\s+mode\b/iu.test(strippedInner)
  ) {
    return blocked(original, 'locking_clause', 'Row-locking clauses (FOR UPDATE/SHARE) are not allowed.');
  }
  if (/\binto\s+(outfile|dumpfile)\b/iu.test(strippedInner)) {
    return blocked(original, 'into_outfile', 'Writing query output to files is not allowed.');
  }
  // Models write `col` out of MySQL habit whatever the dialect, and the Postgresql grammar accepts it.
  if (dialect.quoteChar !== '`' && strippedInner.includes('`')) {
    return blocked(
      original,
      'backtick_identifier',
      `Backtick-quoted identifiers are MySQL-only. ${dialect.promptLabel} quotes identifiers with ${dialect.quoteChar}: write ${dialect.quoteChar}Order Status${dialect.quoteChar}, not \`Order Status\`.`,
    );
  }
  if (dialect.engine === 'sqlite' && sqliteRecursiveWedge(strippedInner)) {
    return blocked(
      original,
      'recursive_no_limit',
      'This recursive query could run without stopping. Add a LIMIT so it stays bounded.',
    );
  }

  // ---- Parse once (fail-closed): `parse` yields the AST and the table list together. ----
  let ast: unknown;
  let tableList: string[] = [];
  try {
    const parsed = parser.parse(inner, { database: dialect.grammar });
    ast = parsed.ast;
    tableList = Array.isArray(parsed.tableList) ? parsed.tableList : [];
  } catch {
    // Fail closed on anything the validator cannot parse; the reason is actionable so the repair loop can recover.
    return blocked(
      original,
      'parse_failed',
      'The safety validator could not parse this query. Quote any identifier that is not a plain word - a column named Order Status must be written "Order Status", not bare. Otherwise rewrite it using plain standard SQL: avoid vendor-specific forms like SUBSTRING(x FROM \'pattern\') and use regexp_replace/split_part or standard function-call syntax instead.',
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
  // Reuse the precomputed default set unless the host added deny functions or allowed file functions.
  const denySet: ReadonlySet<string> =
    policy.denyFunctions.length === 0 && !policy.allowFileFunctions
      ? (DEFAULT_DENY_SETS[dialect.engine] ?? new Set<string>())
      : new Set<string>(
          [
            ...(ENGINE_DENY[dialect.engine] ?? []),
            ...(dialect.engine === 'duckdb'
              ? [...DUCKDB_ONLY_DENY, ...(policy.allowFileFunctions ? [] : DUCKDB_FILE_FUNCTIONS)]
              : []),
            ...policy.denyFunctions,
          ].map((f) => f.toLowerCase()),
        );
  const denySuffixes = dialect.engine === 'duckdb' ? DUCKDB_DENY_SUFFIXES : [];
  // read_/scan_ follows the same allowFileFunctions policy as DUCKDB_FILE_FUNCTIONS.
  const denyPrefixes =
    dialect.engine === 'duckdb' && !policy.allowFileFunctions
      ? [...UNIVERSAL_DENY_PREFIXES, ...DUCKDB_DENY_PREFIXES]
      : UNIVERSAL_DENY_PREFIXES;
  const ctx: WalkContext = { denySet, denySuffixes, denyPrefixes, maxDepth: policy.maxDepth, engine: dialect.engine };
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
    const status = inspectLimit(root, policy.maxRows, body, dialect.engine);
    if (fetchTailText !== null) {
      // The count is lowered inside the original clause. Wrapping in an inline view instead would
      // make duplicate output column names an ORA-00918, though they are legal at top level.
      if (strippedFetchLimit !== null && strippedFetchLimit > policy.maxRows) {
        // Anchored to the FETCH count: a plain replace rewrites an equal OFFSET that precedes it.
        finalSql =
          inner +
          fetchTailText.replace(/(FETCH\s+(?:FIRST|NEXT)\s+)(\d+)/i, (_m, head: string) => `${head}${policy.maxRows}`);
        loweredLimit = true;
      } else {
        finalSql = inner + fetchTailText;
      }
    } else if (status.kind === 'none' && dialect.limitStyle === 'fetch') {
      // Oracle has no LIMIT and node-sql-parser cannot validate FETCH FIRST; the driver caps rows instead.
    } else if (status.kind === 'none') {
      // Textual append preserves the model's exact formatting; the LIMIT binds to the final SELECT, on its own line.
      finalSql = `${body}\nLIMIT ${policy.maxRows}`;
      autoLimited = true;
    } else if (status.kind === 'high') {
      // The number is edited in the original text. Re-serializing the AST quotes every identifier,
      // which changes what `Orders` and `AS Total` mean on a case-folding engine.
      const edited = lowerLimitInText(body, policy.maxRows, dialect.engine);
      if (edited) {
        finalSql = edited;
        loweredLimit = true;
      } else {
        // Keep original; the connector-level maxRows slice is the backstop.
        warnings.push('The row limit is higher than allowed; it is enforced at execution time.');
      }
    } else if (status.kind === 'unbounded') {
      // LIMIT ALL is no bound; swap it for the cap. Anchored, because rewriting a branch's own
      // LIMIT ALL instead would leave the statement unbounded.
      const replaced =
        status.at === undefined
          ? body.replace(/(\blimit\s+)all\b/i, (_m, head: string) => `${head}${policy.maxRows}`)
          : body.slice(0, status.at) +
            body.slice(status.at).replace(/^(limit\s+)all\b/i, (_m, head: string) => `${head}${policy.maxRows}`);
      if (replaced === body) {
        return blocked(
          original,
          'limit_unbounded',
          'A row limit of ALL cannot be capped; ask for a specific number of rows.',
        );
      }
      finalSql = replaced;
      loweredLimit = true;
    } else if (status.kind === 'nonliteral') {
      // A parameter or subquery cannot be rewritten to the cap, and the statement would otherwise
      // leave the guard unbounded.
      return blocked(
        original,
        'limit_nonliteral',
        'The row limit must be a plain number so the row cap can be applied.',
      );
    }
  } else {
    finalSql = explainPrefix + inner;
  }

  return { allowed: true, sql: finalSql, warnings, autoLimited, loweredLimit, tables: tableList };
}
