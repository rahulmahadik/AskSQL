/**
 * The AskSQL security boundary: deterministic, AST-based, fail-closed.
 * Unparseable input is blocked. Allowlist: a single SELECT (CTEs verified
 * recursively), EXPLAIN of a guarded SELECT, and read-only PRAGMA/SHOW per
 * dialect. Per-dialect dangerous-function denylist that policy may only
 * tighten. Auto-LIMIT injection/lowering happens here so every caller gets
 * the same capped SQL.
 */

import pkg from 'node-sql-parser';
import { AskSqlError } from './errors.js';
import { hasMultipleStatements, stripCommentsAndStrings, trimTrailingNoise } from './strip.js';
import type { DialectInfo, EngineKind, GuardPolicy, GuardVerdict } from './types.js';

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
  // Functions that take SQL (or a whole table/schema/database) as a STRING and
  // execute it. The AST walk cannot see inside a string literal, so without these
  // `query_to_xml('SELECT pg_sleep(60)', ...)` bypasses every other denied entry.
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
  // Sequence mutations: read-only on Postgres/MySQL/SQLite via their read-only
  // session, but DuckDB relies solely on the guard, so deny them universally.
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
  // Scanner-extension functions run arbitrary SQL against, or attach, a foreign
  // database (Postgres/MySQL/SQLite) - a write channel through a SELECT. DuckDB
  // autoloads these extensions on first use, and it has no read-only session, so
  // the guard is the only defence.
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
  // httpfs / community extensions make outbound network requests from a SELECT:
  // http_get is SSRF (can reach the cloud instance-metadata endpoint), http_post/put
  // are an exfiltration write channel. read_gsheet / fsdir read external data / dirs.
  'http_get',
  'http_post',
  'http_put',
  'http_delete',
  'http_head',
  'http_patch',
  'read_gsheet',
  'fsdir',
  // query()/query_table() execute a SQL string in the same connection - the AST
  // walk cannot see inside the string, so this is the string-exec class (like
  // Postgres query_to_xml). A wrapped read_csv reads any file.
  'query',
  'query_table',
  // Secret/credential loaders and session mutators.
  'load_aws_credentials',
  'set_current_schema',
];

/**
 * DuckDB function-name suffixes that are always a foreign-DB/scanner escape,
 * whatever the extension prefix. Denylisting names alone cannot keep up with
 * DuckDB's open extension surface, so any `<x>_execute` / `<x>_query` / `<x>_scan`
 * / `<x>_attach` is refused on the duckdb dialect.
 */
const DUCKDB_DENY_SUFFIXES = ['_execute', '_query', '_scan', '_attach'];

/** Postgres file/dir disclosure families - every member is admin-only, never a read-only analytics call. */
const PG_DENY_PREFIXES = ['pg_ls_', 'pg_read_'];

/**
 * DuckDB function-name prefixes that are always a file/data reader (read_csv,
 * read_parquet, read_avro, read_arrow, scan_arrow_ipc, ...). Registered files are
 * queried by their VIEW name, never through a read_/scan_ call, so denying the
 * whole prefix closes the arbitrary-file-read class against any current or future
 * reader extension rather than chasing individual names.
 */
const DUCKDB_DENY_PREFIXES = ['read_', 'scan_'];

/**
 * Denied only on the DuckDB dialect (not universal): current_setting reads back a
 * setting value and is a legitimate read on Postgres, but on DuckDB it discloses
 * cloud credentials configured via SET; prompt/open_prompt (flockmtl) make outbound
 * LLM/HTTP calls.
 */
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
  // Parquet metadata readers also take a file path and disclose file contents
  // (per-row-group min/max statistics) + probe the filesystem.
  'parquet_metadata',
  'parquet_schema',
  'parquet_file_metadata',
  'parquet_kv_metadata',
  'read_json_objects_auto',
  'read_ndjson_objects',
];

// Bare SSRF constructors: build a URL type from a string and fetch it inside a
// SELECT. Never a legitimate analytics call, so denied on every dialect.
const ORACLE_DENY_FUNCTIONS = ['httpuritype', 'dburitype', 'xdburitype'];

/**
 * Oracle package prefixes that expose the filesystem, network, scheduler, or a
 * SQL-string executor. Matched against the schema-qualified name (e.g.
 * `sys.utl_http.request` ends with `utl_http.request`), so any package member
 * is refused, not just a hand-listed set. dbms_lob/dbms_metadata read server
 * state a read-only analytics query never needs.
 */
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

/**
 * Defense in depth: block every known-dangerous function on every dialect,
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

/**
 * Precomputed lowercase deny-sets for the DEFAULT policy (no host-added deny
 * functions, file functions denied) per engine. The base lists are already
 * lowercase literals, so this avoids rebuilding a Set and re-lowercasing
 * ~50 entries on every guard call (guardSql runs 1-3× per ask).
 */
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

/**
 * True if the SQL contains a MySQL executable comment opener (`/*!`) outside a
 * string literal. String literals are skipped so a legitimate `WHERE x = '/*!'`
 * is not a false positive.
 */
function hasMysqlExecutableComment(sql: string): boolean {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
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
    // Skip line comments: a `/*!` inside `-- ...` or `# ...` is not executed by
    // MySQL, so it must not trip the gate (over-block of a legit SELECT).
    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    // Skip ordinary block comments so a `/*!` nested after a plain `/* ... */` is
    // still found by the outer scan (we only bail on the executable opener itself).
    if (c === '/' && sql[i + 1] === '*' && sql[i + 2] === '!') return true;
    i++;
  }
  return false;
}

/**
 * True for a SQLite recursive CTE that a caller forces to full materialization
 * (an aggregate, DISTINCT or GROUP BY) with no LIMIT to bound it. `node:sqlite`
 * runs synchronously on the extension-host thread, so such a query - e.g.
 * `WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r`
 * - never returns and freezes the whole window (Stop is inert). A plain
 * `SELECT ... FROM r` streams lazily and is bounded by the auto-LIMIT, so it is safe.
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

/**
 * True when a relation name is a filesystem path, URL, or bare data-file name -
 * anything DuckDB's replacement scan would read as a file. Registered file
 * views are named without an extension, so they are unaffected.
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
      if (parts.length > 0) {
        // Prepend the package/schema qualifier (e.g. UTL_HTTP.REQUEST) so Oracle
        // package prefixes match; the unqualified last segment is checked separately.
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

  // A relation named like a file path or URL: DuckDB's replacement scan reads
  // it as a file with no function node for the denylist to catch. Legitimate
  // table names never look like paths or URLs, so blocking these closes the
  // file-read/SSRF surface on every dialect.
  const tableRef = node['table'];
  if (typeof tableRef === 'string' && looksLikeFileOrUrl(tableRef)) {
    ctx.violation = {
      ruleId: 'file_relation',
      reason: 'Reading a file or URL directly in a query is not allowed. Query registered tables by name.',
    };
    return;
  }

  // Oracle `seq.nextval` parses as a column, not a function, so the denylist never
  // sees it; advancing a sequence is a write, so it is blocked on the Oracle dialect.
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
      // Oracle package prefixes (utl_http.) match the schema-qualified name; the
      // others (pg_ls_, read_) are bare and match the unqualified last segment.
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

type LimitStatus = { kind: 'none' } | { kind: 'ok' } | { kind: 'nonliteral' } | { kind: 'high'; lower: () => void };

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
  // Bare `OFFSET n` (no LIMIT) is a single value with seperator 'offset'; n is the offset, not a
  // row count. Treat as no limit so auto-LIMIT injects, and never lower it (that corrupts pagination).
  if (existing.seperator === 'offset' && existing.value.length === 1) {
    return { kind: 'none' };
  }
  // MySQL `LIMIT offset, count` -> count is value[1]; else value[0] (incl. `LIMIT n OFFSET m`).
  const countIndex = existing.seperator === ',' && existing.value.length === 2 ? 1 : 0;
  const countNode = existing.value[countIndex];
  if (!countNode || countNode.type !== 'number' || typeof countNode.value !== 'number') {
    return { kind: 'nonliteral' };
  }
  if (countNode.value > maxRows) {
    return {
      kind: 'high',
      lower: () => {
        countNode.value = maxRows;
      },
    };
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
    denyFunctions: [...DEFAULT_GUARD_POLICY.denyFunctions, ...(partial?.denyFunctions ?? [])],
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

  // MySQL executes the body of `/*! ... */` and `/*!NNNNN ... */` comments, but
  // the stripper (and node-sql-parser) treat them as ordinary comments and delete
  // the code, so INTO OUTFILE, load_file, sleep, FOR UPDATE and multi-statements
  // hidden inside one reach the server unseen. Fail closed: these are never in a
  // legitimate read-only SELECT.
  if (dialect.engine === 'mysql' && hasMysqlExecutableComment(trimmed)) {
    return blocked(original, 'mysql_executable_comment', 'MySQL executable comments (/*! ... */) are not allowed.');
  }

  const stripped = stripCommentsAndStrings(trimmed);
  if (hasMultipleStatements(stripped)) {
    return blocked(original, 'multi_statement', 'Only a single statement is allowed.');
  }
  const strippedTrim = stripped.trim().replace(/;\s*$/u, '');
  // Strip trailing `;`, whitespace and comments: a trailing comment after a `;`
  // (`SELECT 1; --`) hides the `;` from a naive end-anchored replace, and the
  // later textual auto-LIMIT append would then land after the `;` as a dangling
  // fragment while the row cap is silently commented/severed off.
  const body = trimTrailingNoise(trimmed);

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
  const explainMatch = /^\s*explain(\s+query\s+plan|\s+analyze|\s+verbose|\s*\([^)]*\))*\s+/iu.exec(body);
  if (explainMatch) {
    explainPrefix = body.slice(0, explainMatch[0].length);
    inner = body.slice(explainMatch[0].length);
    // EXPLAIN ANALYZE executes its target, but the inner statement is verified
    // as a guarded SELECT below via the normal path, so no special handling.
  }

  // ---- Lexical read-only floor (belt for shapes the AST may not expose) ----
  const strippedInner = stripCommentsAndStrings(inner);
  // MySQL's `LOCK IN SHARE MODE` is the older spelling of `FOR SHARE` and takes
  // the same row locks, so it must be blocked alongside FOR UPDATE/SHARE.
  if (
    /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/iu.test(strippedInner) ||
    /\block\s+in\s+share\s+mode\b/iu.test(strippedInner)
  ) {
    return blocked(original, 'locking_clause', 'Row-locking clauses (FOR UPDATE/SHARE) are not allowed.');
  }
  if (/\binto\s+(outfile|dumpfile)\b/iu.test(strippedInner)) {
    return blocked(original, 'into_outfile', 'Writing query output to files is not allowed.');
  }
  if (dialect.engine === 'sqlite' && sqliteRecursiveWedge(strippedInner)) {
    return blocked(
      original,
      'recursive_no_limit',
      'This recursive query could run without stopping. Add a LIMIT so it stays bounded.',
    );
  }

  // ---- Parse once (fail-closed). `parse` yields the AST and the table
  // list together, so the engine's hallucination check can reuse the list
  // instead of re-parsing the same SQL. ----
  let ast: unknown;
  let tableList: string[] = [];
  try {
    const parsed = parser.parse(inner, { database: dialect.grammar });
    ast = parsed.ast;
    tableList = Array.isArray(parsed.tableList) ? parsed.tableList : [];
  } catch {
    // Fail closed on anything the validator cannot parse. The reason is actionable
    // so the repair loop can recover: some valid vendor syntax (e.g. Postgres
    // SUBSTRING(x FROM 'pat')) is not understood by the parser, and rewriting it in
    // plain standard SQL both parses and runs.
    return blocked(
      original,
      'parse_failed',
      "The safety validator could not parse this query. Rewrite it using plain standard SQL - avoid vendor-specific forms like SUBSTRING(x FROM 'pattern'); use regexp_replace/split_part or standard function-call syntax instead.",
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
      ? (DEFAULT_DENY_SETS[dialect.engine] ?? new Set<string>())
      : new Set<string>(
          [
            ...(ENGINE_DENY[dialect.engine] ?? []),
            ...(dialect.engine === 'duckdb' && !policy.allowFileFunctions
              ? [...DUCKDB_FILE_FUNCTIONS, ...DUCKDB_ONLY_DENY]
              : []),
            ...policy.denyFunctions,
          ].map((f) => f.toLowerCase()),
        );
  const denySuffixes = dialect.engine === 'duckdb' ? DUCKDB_DENY_SUFFIXES : [];
  // read_/scan_ is the file-reader class, so it follows the same allowFileFunctions
  // policy as DUCKDB_FILE_FUNCTIONS (a browser sandbox may permit file reads).
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
    const status = inspectLimit(root, policy.maxRows);
    if (status.kind === 'none' && dialect.limitStyle === 'fetch') {
      // Oracle has no LIMIT, and node-sql-parser cannot validate FETCH FIRST, so
      // appending either would break. The connector's driver-level maxRows caps the
      // fetch after any ORDER BY (a correct top-N), so no SQL-level limit is injected.
    } else if (status.kind === 'none') {
      // Textual append preserves the model's exact formatting (the "show
      // query" surface stays faithful) - the guard already proved this is a
      // single SELECT and `body` is trimmed of trailing `;`/comments, so the
      // appended LIMIT binds to the final SELECT (incl. set-ops). The own-line
      // placement is defence-in-depth against any trailing line comment.
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
