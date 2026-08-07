/**
 * Driver-agnostic DuckDB logic shared by the Node (`@duckdb/node-api`) and
 * browser (`@duckdb/duckdb-wasm`) connectors: file-format resolution,
 * table-name sanitization, introspection SQL + catalog assembly, row-value
 * shaping, and the query timeout race.
 */

import {
  AskSqlError,
  type CapabilityFlags,
  type CellValue,
  type ColumnInfo,
  type ResultColumn,
  type SchemaCatalog,
  type TableInfo,
} from '@asksql/core/runtime';

export type FileFormat = 'csv' | 'json' | 'ndjson' | 'parquet' | 'xlsx' | 'sql' | 'auto';

export interface FileSource {
  /** Table name to register the file as (sanitized). */
  readonly table: string;
  readonly path: string;
  readonly format?: FileFormat;
  /** CSV text encoding (e.g. 'utf-8', 'utf-16', 'latin-1'). Default: sniffed. */
  readonly encoding?: string;
  /**
   * Excel worksheet to read (by name, e.g. 'Q1 Sales'). Only used for `xlsx`; defaults to the first sheet.
   * Register the same workbook once per sheet with distinct `table` names to query several sheets.
   */
  readonly sheet?: string;
  /** Allow a URL path (http/s3/...). Off by default - a URL means a network read. */
  readonly allowRemote?: boolean;
  /** Allow glob metacharacters in the path to match multiple files. Off by default. */
  readonly allowGlob?: boolean;
}

export const DUCK_CAPABILITIES: CapabilityFlags = {
  supportsCancel: false,
  supportsExplain: true,
  supportsSchemas: true,
  readOnlySession: false,
  supportsMatViews: false,
  supportsTriggers: false,
  supportsRoutines: true,
};

const RESERVED_TABLE_NAMES = new Set([
  'order',
  'group',
  'select',
  'from',
  'where',
  'table',
  'user',
  'join',
  'on',
  'having',
  'limit',
  'offset',
  'union',
  'all',
  'and',
  'or',
  'not',
  'null',
  'as',
  'by',
  'into',
  'values',
  'set',
  'case',
  'when',
  'then',
  'else',
  'end',
  'semi',
  'anti',
  'asof',
  'using',
  'natural',
  'cross',
  'inner',
  'outer',
  'left',
  'right',
  'full',
  'distinct',
  'exists',
  'in',
  'is',
  'like',
  'between',
  'desc',
  'asc',
  'pivot',
  'unpivot',
  'window',
  'qualify',
  'sample',
  'exclude',
]);

/** Make a safe SQL identifier from a user filename. */
export function sanitizeTableName(raw: string): string {
  const base = raw.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  let cleaned = /^[A-Za-z_]/.test(base) ? base : `t_${base}`;
  if (RESERVED_TABLE_NAMES.has(cleaned.toLowerCase())) cleaned = `${cleaned}_data`;
  return cleaned.slice(0, 63) || 't_file';
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
export function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Require a plain local path: a URL scheme makes DuckDB fetch over the network and a glob
 * metacharacter fans one registration out to many files. Both need `allowRemote` / `allowGlob`.
 */
export function assertSafeFilePath(file: FileSource): void {
  if (!file.allowRemote && /^[a-z][a-z0-9+.-]*:\/\//i.test(file.path)) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'remote file URL not allowed',
      userMessage: `"${basename(file.path)}" is a URL. Set allowRemote to read files over the network.`,
    });
  }
  if (!file.allowGlob && /[*?[\]{}]/.test(file.path)) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'glob metacharacters not allowed in file path',
      userMessage: `"${basename(file.path)}" contains a wildcard. Set allowGlob to match multiple files.`,
    });
  }
}

export function resolveFormat(file: FileSource): Exclude<FileFormat, 'auto'> {
  if (file.format && file.format !== 'auto') return file.format;
  const lower = file.path.toLowerCase();
  if (lower.endsWith('.parquet')) return 'parquet';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  if (lower.endsWith('.ndjson')) return 'ndjson';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.sql')) return 'sql';
  return 'csv';
}

/**
 * Reject, before a .sql upload is executed, vendor dumps DuckDB cannot parse and statements
 * that reach the filesystem, network, or extensions. What survives is CREATE TABLE / INSERT.
 */
/**
 * Blanks the bodies of string and quoted-identifier literals - and, unless `keepComments`, of
 * comments too - keeping the delimiters, newlines and offsets. A comment then cannot split a
 * call from its name, and a row value cannot look like a statement.
 */
function blankLiterals(sql: string, keepComments = false): string {
  let out = '';
  let i = 0;
  const blankWhile = (stop: () => boolean): void => {
    while (i < sql.length && !stop()) {
      out += sql[i] === '\n' ? '\n' : ' ';
      i++;
    }
  };
  const copyWhile = (stop: () => boolean): void => {
    while (i < sql.length && !stop()) out += sql[i++];
  };
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      (keepComments ? copyWhile : blankWhile)(() => sql[i] === '\n');
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      (keepComments ? copyWhile : blankWhile)(() => sql[i] === '*' && sql[i + 1] === '/');
      out += keepComments ? sql.slice(i, i + 2) : '  ';
      i += 2;
      continue;
    }
    // $tag$ ... $tag$ is a DuckDB string. Without this, a quote inside one opened a literal scan
    // that blanked the statements after it, hiding them from every check below.
    if (sql[i] === '$') {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      if (sql[j] === '$') {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        const end = close === -1 ? sql.length : close + tag.length;
        while (i < end) {
          out += sql[i] === '\n' ? '\n' : ' ';
          i++;
        }
        continue;
      }
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]!;
      out += sql[i++];
      // A doubled quote is an escape, not the end of the literal.
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          out += '  ';
          i += 2;
          continue;
        }
        if (sql[i] === quote) break;
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < sql.length) out += sql[i++];
      continue;
    }
    out += sql[i++];
  }
  return out;
}

export function validateSqlDump(content: string): void {
  // Checked outside literals and comments: `read_csv/**/('/etc/passwd')` is the same call as
  // `read_csv(...)`, while the row value 'EXPORT' is data, not a statement.
  const scanned = blankLiterals(content);
  // mysqldump's own `/*!40101 ... */` is executable syntax, so this one keeps comments.
  const code = blankLiterals(content, true);
  if (/`/.test(scanned) || /\bENGINE\s*=/i.test(scanned) || /\/\*!\d/.test(code)) {
    throw new AskSqlError('FILE_PARSE', {
      detail: 'mysqldump syntax detected in .sql upload',
      userMessage:
        'This looks like a MySQL (mysqldump) file, which cannot be loaded directly. Re-export it as CSV, or as portable SQL - plain CREATE TABLE and INSERT statements.',
    });
  }
  if (
    /\bCOPY\b[\s\S]*?\bFROM\s+stdin/i.test(scanned) ||
    /^\s*\\[.]/m.test(scanned) ||
    /^\s*\\connect\b/im.test(scanned)
  ) {
    throw new AskSqlError('FILE_PARSE', {
      detail: 'pg_dump syntax detected in .sql upload',
      userMessage:
        'This looks like a PostgreSQL (pg_dump) file, which cannot be loaded directly. Re-export it as CSV, or with "pg_dump --inserts" so it uses plain INSERT statements.',
    });
  }
  // Match the whole reader/scan family by prefix, plus a bare quoted FROM path (DuckDB's file shorthand).
  const danger =
    /\b(ATTACH|INSTALL|LOAD|COPY|IMPORT|EXPORT)\b/i.exec(scanned) ??
    /\b((?:read_|scan_)\w*)\s*\(/i.exec(scanned) ??
    /\b(parquet_scan|sniff_csv|glob|delta_scan|iceberg_scan|st_read\w*)\s*\(/i.exec(scanned) ??
    /\b(FROM)\s+'[^']*'/i.exec(scanned);
  if (danger) {
    throw new AskSqlError('FILE_PARSE', {
      detail: `disallowed statement in .sql upload: ${danger[0]}`,
      userMessage: `This SQL file uses "${(danger[1] ?? danger[0]).toUpperCase()}", which is not allowed in an uploaded file - it could read other files or reach the network. Uploaded SQL may only create tables and insert data.`,
    });
  }
}

/** SQL reader expression for a file source (path already registered/available). */
export function readerFor(file: FileSource, format: Exclude<FileFormat, 'auto'>): string {
  assertSafeFilePath(file);
  const p = sqlStr(file.path);
  switch (format) {
    case 'sql':
      // .sql is executed to build tables, not read via a table function.
      throw new AskSqlError('FILE_PARSE', { detail: 'readerFor called for sql format' });
    case 'parquet':
      return `read_parquet(${p})`;
    case 'json':
    case 'ndjson':
      return `read_json_auto(${p})`;
    case 'xlsx':
      return file.sheet ? `read_xlsx(${p}, sheet = ${sqlStr(file.sheet)})` : `read_xlsx(${p})`;
    case 'csv':
    default: {
      const enc = file.encoding ? `, encoding=${sqlStr(file.encoding)}` : '';
      // null_padding: without it a row with too few columns makes the sniffer re-read the file as
      // a different shape and drop rows, with no error.
      return `read_csv_auto(${p}${enc}, null_padding=true)`;
    }
  }
}

/** Pick a non-colliding table name given already-registered names. */
export function uniqueTableName(base: string, registered: ReadonlySet<string>): string {
  if (!registered.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}_${i}`.slice(0, 63);
    if (!registered.has(candidate)) return candidate;
  }
  return `${base}_${registered.size}`;
}

export const INTROSPECT_COLUMNS_SQL = `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
 FROM information_schema.columns
 WHERE table_schema NOT IN ('information_schema','pg_catalog')
 ORDER BY table_schema, table_name, ordinal_position`;

export const INTROSPECT_VIEWS_SQL = `SELECT table_name FROM information_schema.tables WHERE table_type='VIEW'`;

/** Build a SchemaCatalog from introspection rows (driver-agnostic). */
export function buildDuckCatalog(
  columnRows: readonly Record<string, unknown>[],
  viewNames: ReadonlySet<string>,
  registered: ReadonlySet<string>,
  warnings: string[],
): SchemaCatalog {
  const byTable = new Map<string, { schema: string; name: string; columns: ColumnInfo[] }>();
  for (const r of columnRows) {
    const schema = String(r['table_schema']);
    const name = String(r['table_name']);
    const key = `${schema}.${name}`;
    let t = byTable.get(key);
    if (!t) byTable.set(key, (t = { schema, name, columns: [] }));
    t.columns.push({
      name: String(r['column_name']),
      dbType: String(r['data_type']),
      nullable: String(r['is_nullable']).toUpperCase() === 'YES',
      default: r['column_default'] == null ? null : String(r['column_default']),
    });
  }

  const tables: TableInfo[] = [...byTable.values()].map((t) => {
    const isFile = registered.has(t.name);
    return {
      schema: t.schema === 'main' ? undefined : t.schema,
      name: t.name,
      kind: (isFile ? 'table' : viewNames.has(t.name) ? 'view' : 'table') as TableInfo['kind'],
      columns: t.columns,
      primaryKey: [],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: isFile ? ('file' as const) : ('db' as const),
    };
  });

  return {
    engine: 'duckdb',
    schemas: [...new Set(tables.map((t) => t.schema ?? 'main'))],
    tables,
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

/** Shape a raw DuckDB cell value to a JSON-safe {@link CellValue}. */
export function shapeDuckValue(v: unknown, kind: ResultColumn['kind']): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(v))) {
    const bytes = v as Uint8Array;
    const hex = Array.from(bytes.subarray(0, 16))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { __binary: { bytes: bytes.length, hexPreview: hex } };
  }
  if (v instanceof Date) return v.toISOString();
  if (kind === 'bigint' || kind === 'decimal') return typeof v === 'string' ? v : String(v);
  // DOUBLE supports 'nan'/'inf'; non-finite numbers are not legal JSON (they become null).
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return v;
  // LIST/STRUCT/MAP wrappers can hold bigint members, which JSON.stringify refuses to
  // serialize - and the throw would escape execute() as a raw TypeError. Stringify them.
  if (typeof v === 'object') {
    return JSON.stringify(v, (_key, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
  }
  return String(v);
}

/**
 * Classify an Apache Arrow type name as DuckDB-WASM returns them ("Int64", "Decimal<...>", "Utf8")
 * into a ColumnKind, falling back to SQL type names for the Node driver.
 */
export function classifyDuckType(typeStr: string | undefined): ResultColumn['kind'] {
  if (!typeStr) return 'unknown';
  const t = typeStr.toLowerCase();
  // Most-specific first: "bigint"/"Int64" beats the generic int check, and "decimal" beats everything numeric.
  if (/bool/.test(t)) return 'boolean';
  if (/decimal|numeric/.test(t)) return 'decimal';
  if (/bigint|hugeint|int64|int128/.test(t)) return 'bigint';
  if (/timestamp|datetime/.test(t)) return 'timestamp';
  if (/date/.test(t)) return 'date';
  if (
    /float|double|real|serial|\bint\b|integer|int8|int4|int2|int16|int32|tinyint|smallint|mediumint|uint|number/.test(t)
  )
    return 'number';
  if (/utf8|string|varchar|char|text|uuid|enum/.test(t)) return 'text';
  if (/binary|blob|bytea|bit/.test(t)) return 'binary';
  if (/struct|list|map|json|array/.test(t)) return 'json';
  return 'unknown';
}

/** Build ResultColumns from names + type strings (Arrow or SQL type names). */
export function buildResultColumns(
  names: readonly string[],
  typeStrings: readonly (string | undefined)[],
): ResultColumn[] {
  return names.map((name, i) => ({
    name,
    dbType: typeStrings[i],
    kind: classifyDuckType(typeStrings[i]),
  }));
}

/** Race a query promise against a timeout + abort signal; `onCancel` (the driver interrupt) fires on either. */
export function withQueryTimeout<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal,
  onCancel?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onCancel?.();
      reject(new AskSqlError('DB_TIMEOUT', { detail: `duckdb query exceeded ${ms}ms` }));
    }, ms);
    const onAbort = () => {
      onCancel?.();
      reject(new AskSqlError('CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export function mapQueryError(err: unknown): AskSqlError {
  if (AskSqlError.is(err)) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new AskSqlError('DB_QUERY_ERROR', {
    userMessage: `The query failed: ${msg.split('\n')[0]!.slice(0, 200)}`,
    detail: msg,
    cause: err,
  });
}

/** Basename from a path using either separator (works on Windows + POSIX). */
export function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function mapFileError(file: FileSource, err: unknown): AskSqlError {
  const msg = err instanceof Error ? err.message : String(err);
  return new AskSqlError('FILE_PARSE', {
    userMessage: `Couldn't read "${basename(file.path)}": ${msg.split('\n')[0]!.slice(0, 160)}`,
    detail: msg,
    cause: err,
  });
}
