/**
 * @asksql/duckdb - DuckDB connector (Node, the zero-backend file path).
 * Registers uploaded files (CSV / JSON / NDJSON / Parquet / Excel) as named views and answers
 * questions over them; large files stream rather than materialize. The browser build is
 * `@asksql/duckdb/browser`; both share `./shared.ts`.
 */

import {
  epochUnitOf,
  isJsonCandidateColumn,
  isMomentColumn,
  jsonArrayElementOf,
  jsonHint,
  jsonShapeOf,
  JSON_SAMPLE_ROWS,
  MAX_HINT_PROBES,
  MAX_HINT_PROBES_PER_TABLE,
} from '@asksql/core';
import type { ColumnInfo, TableInfo } from '@asksql/core';
import {
  AskSqlError,
  DUCKDB_DIALECT,
  VALUE_SAMPLE_MAX_DISTINCT,
  type Connector,
  type ExecuteOptions,
  type ResultSet,
  type SchemaCatalog,
} from '@asksql/core/runtime';
import { readFile } from 'node:fs/promises';
import {
  assertSafeFilePath,
  buildDuckCatalog,
  withDuckColumnHints,
  buildResultColumns,
  DUCK_CAPABILITIES,
  INTROSPECT_COLUMNS_SQL,
  INTROSPECT_VIEWS_SQL,
  mapFileError,
  mapQueryError,
  quoteIdent,
  readerFor,
  resolveFormat,
  sanitizeTableName,
  shapeDuckValue,
  uniqueTableName,
  validateSqlDump,
  withQueryTimeout,
  type FileSource,
} from './shared.js';

export { sanitizeTableName } from './shared.js';
export type { FileFormat, FileSource } from './shared.js';

export interface DuckDbConnectorConfig {
  readonly id: string;
  readonly name: string;
  /** ':memory:' (default) or a database file path. */
  readonly path?: string;
  /** Files to register as views on connect. */
  readonly files?: readonly FileSource[];
  /** Opt-in: sample distinct values from short text columns, so the model sees the real codes a `status VARCHAR` holds. */
  readonly sampleColumnValues?: boolean;
}

// Value sampling (opt-in) guards.
const MAX_SAMPLED_COLUMNS = 300;
const MAX_SAMPLE_VALUE_LEN = 64;

/** DuckDB text-ish types worth sampling; numeric/temporal/nested are not. */
function isSampleableDuckType(dbType: string): boolean {
  return /^(varchar|char|bpchar|text|string)\b/i.test(dbType.trim());
}

interface DuckPrepared {
  runAndReadUntil(targetRowCount: number): Promise<DuckReader>;
}
interface DuckConnection {
  run(sql: string): Promise<unknown>;
  runAndReadUntil(sql: string, targetRowCount: number): Promise<DuckReader>;
  /** Compiles exactly ONE statement; throws on a multi-statement string. */
  prepare(sql: string): Promise<DuckPrepared>;
  /** Aborts the running query so a timeout doesn't wedge the shared connection. */
  interrupt?(): void;
  closeSync?(): void;
  disconnectSync?(): void;
}
interface DuckReader {
  getRowObjects(): Record<string, unknown>[];
  /** Positional rows: preserves duplicate output column names that getRowObjects() collapses. */
  getRows(): unknown[][];
  columnNames(): string[];
  columnTypes?(): { toString?(): string }[];
}
interface DuckInstance {
  connect(): Promise<DuckConnection>;
  closeSync?(): void;
}

/** DuckDB refuses an in-memory database in read-only mode, so only a real file can be opened that way. */
function isFilePath(path: string | undefined): path is string {
  return !!path && path !== ':memory:' && !path.startsWith(':memory:');
}

export class DuckDbConnector implements Connector {
  readonly engine = 'duckdb' as const;
  readonly dialect = DUCKDB_DIALECT;
  readonly capabilities = DUCK_CAPABILITIES;
  readonly id: string;
  readonly name: string;
  readonly database?: string;
  private instance: DuckInstance | null = null;
  private conn: DuckConnection | null = null;
  private excelLoaded = false;
  private readonly registered = new Set<string>();
  /** Tail of the execute() chain: `interrupt()` aborts whatever the shared connection is running. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: DuckDbConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
    // Display hint: the database file's base name, or in-memory when none.
    this.database = config.path ? config.path.split(/[\\/]/).pop() || undefined : 'in-memory';
  }

  private async api(): Promise<{
    DuckDBInstance: { create(path?: string, options?: Record<string, string>): Promise<DuckInstance> };
  }> {
    try {
      return (await import('@duckdb/node-api')) as unknown as {
        DuckDBInstance: { create(path?: string, options?: Record<string, string>): Promise<DuckInstance> };
      };
    } catch (err) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `cannot import @duckdb/node-api: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: 'The DuckDB engine is not installed. Run: npm install @duckdb/node-api',
        cause: err,
      });
    }
  }

  async connect(): Promise<void> {
    if (this.conn) return;
    const { DuckDBInstance } = await this.api();
    const path = this.config.path ?? ':memory:';
    // Registering files writes views into the database, so only a plain database file is read-only.
    const readOnly = isFilePath(path) && (this.config.files ?? []).length === 0;
    try {
      this.instance = await DuckDBInstance.create(path, readOnly ? { access_mode: 'READ_ONLY' } : undefined);
      this.conn = await this.instance.connect();
    } catch (err) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `cannot open duckdb database "${path}": ${err instanceof Error ? err.message : String(err)}`,
        userMessage: `Could not open the DuckDB database "${path}". Check that the path is correct and the file exists.`,
        cause: err,
      });
    }
    // DuckDB implicitly autoloads known extensions (httpfs, the postgres/mysql/sqlite scanners,
    // spatial, gsheets); turning that off leaves only explicit INSTALL/LOAD, as used for excel.
    for (const stmt of ['SET autoinstall_known_extensions=false', 'SET autoload_known_extensions=false']) {
      try {
        await this.conn.run(stmt);
      } catch {
        // Older DuckDB may not expose these settings; the guard denylist still applies.
      }
    }
    if (readOnly) await this.assertReadOnly(path);
    for (const f of this.config.files ?? []) await this.registerFile(f);
  }

  /** Read `access_mode` back, so an option the driver ignored cannot leave a writable handle in use. */
  private async assertReadOnly(path: string): Promise<void> {
    let mode = '';
    try {
      const reader = await this.connection().runAndReadUntil("SELECT current_setting('access_mode') AS m", 1);
      mode = String(reader.getRowObjects()[0]?.['m'] ?? '');
    } catch (err) {
      mode = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (mode.toLowerCase() !== 'read_only') {
      await this.close();
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `duckdb database "${path}" reports access_mode=${mode || '(none)'}, not read_only`,
        userMessage: `The DuckDB database "${path}" could not be opened read-only, so AskSQL will not use it.`,
      });
    }
  }

  async close(): Promise<void> {
    try {
      this.conn?.disconnectSync?.();
      this.conn?.closeSync?.();
      this.instance?.closeSync?.();
    } catch {
      /* nothing actionable on close */
    }
    this.conn = null;
    this.instance = null;
  }

  private connection(): DuckConnection {
    if (!this.conn) throw new AskSqlError('DB_UNREACHABLE', { detail: 'duckdb not connected' });
    return this.conn;
  }

  /**
   * Register a file as a view. Duplicate names are versioned;
   * large files stream. Returns the actual table name used.
   */
  async registerFile(file: FileSource): Promise<string> {
    const conn = this.connection();
    const format = resolveFormat(file);
    // A .sql file is executed to build its own tables, not read as one table.
    if (format === 'sql') return this.registerSqlDump(file);
    const table = uniqueTableName(sanitizeTableName(file.table), this.registered);
    if (format === 'xlsx') await this.ensureExcel();
    const reader = readerFor(file, format);
    try {
      await conn.run(`CREATE VIEW ${quoteIdent(table)} AS SELECT * FROM ${reader}`);
      this.registered.add(table);
      return table;
    } catch (err) {
      throw mapFileError(file, err);
    }
  }

  /**
   * Load a portable .sql dump (CREATE TABLE + INSERT) and expose the tables it creates.
   * Vendor dumps (mysqldump / pg_dump) and file/network statements are rejected before
   * anything runs. Returns the first table the script created.
   */
  private async registerSqlDump(file: FileSource): Promise<string> {
    assertSafeFilePath(file);
    let content: string;
    try {
      content = await readFile(file.path, 'utf8');
    } catch (err) {
      throw mapFileError(file, err);
    }
    validateSqlDump(content);
    const conn = this.connection();
    const before = await this.tableNames();
    try {
      await conn.run(content);
    } catch (err) {
      throw mapFileError(file, err);
    }
    const created = [...(await this.tableNames())].filter((t) => !before.has(t));
    if (created.length === 0) {
      throw new AskSqlError('FILE_PARSE', {
        detail: 'sql upload created no tables',
        userMessage: `"${file.path.split(/[\\/]/).pop()}" ran but created no tables. An uploadable SQL file must CREATE TABLE and INSERT its data.`,
      });
    }
    for (const t of created) this.registered.add(t);
    return created[0]!;
  }

  /** Names of tables/views currently in the main schema. */
  private async tableNames(): Promise<Set<string>> {
    const reader = await this.connection().runAndReadUntil(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'",
      100_000,
    );
    return new Set(reader.getRowObjects().map((r) => String(r['table_name'])));
  }

  /** Remove a previously registered file source (view for data files, table for a .sql dump). */
  async unregisterFile(table: string): Promise<void> {
    const name = sanitizeTableName(table);
    if (!this.registered.has(name)) return;
    await this.connection()
      .run(`DROP VIEW IF EXISTS ${quoteIdent(name)}`)
      .catch(() => {});
    await this.connection()
      .run(`DROP TABLE IF EXISTS ${quoteIdent(name)}`)
      .catch(() => {});
    this.registered.delete(name);
  }

  /** Names currently registered from files. */
  registeredTables(): readonly string[] {
    return [...this.registered];
  }

  private async ensureExcel(): Promise<void> {
    if (this.excelLoaded) return;
    try {
      await this.connection().run('INSTALL excel');
      await this.connection().run('LOAD excel');
      this.excelLoaded = true;
    } catch (err) {
      throw new AskSqlError('FILE_PARSE', {
        userMessage:
          'Excel support needs the DuckDB "excel" extension, which could not be loaded (offline?). Convert the file to CSV.',
        detail: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    }
  }

  async introspect(): Promise<SchemaCatalog> {
    const conn = this.connection();
    const warnings: string[] = [];
    let columnRows: Record<string, unknown>[] = [];
    try {
      columnRows = (await conn.runAndReadUntil(INTROSPECT_COLUMNS_SQL, 100_000)).getRowObjects();
    } catch (err) {
      warnings.push(`Could not introspect columns: ${err instanceof Error ? err.message : String(err)}`);
    }
    let viewNames = new Set<string>();
    try {
      viewNames = new Set(
        (await conn.runAndReadUntil(INTROSPECT_VIEWS_SQL, 100_000)).getRowObjects().map((r) => String(r['table_name'])),
      );
    } catch {
      /* views are optional */
    }
    const catalog = buildDuckCatalog(columnRows, viewNames, this.registered, warnings);
    const withValues = this.config.sampleColumnValues ? await this.attachSampledValues(catalog) : catalog;
    // The hint pass is shared with the browser build; see withDuckColumnHints.
    return withDuckColumnHints(
      withValues,
      async (sql: string, maxRows: number) => (await this.connection().runAndReadUntil(sql, maxRows)).getRowObjects(),
      this.config.sampleColumnValues === true,
    );
  }

  /** Opt-in: enrich short non-enum text columns with the distinct codes they hold, rebuilding the catalog immutably. */
  private async attachSampledValues(catalog: SchemaCatalog): Promise<SchemaCatalog> {
    // NUL-joined key: identifiers may contain dots, which a plain "a.b.c" join would confuse.
    const key = (schema: string | undefined, table: string, col: string): string =>
      [schema ?? 'main', table, col].join('\u0000');
    const sampled = new Map<string, string[]>();
    let budget = MAX_SAMPLED_COLUMNS;
    for (const t of catalog.tables) {
      if (t.kind === 'view') continue; // sampling a view runs its query
      for (const c of t.columns) {
        if (budget <= 0) break;
        if (!isSampleableDuckType(c.dbType)) continue;
        budget--;
        try {
          const values = await this.sampleColumn(t.schema, t.name, c.name);
          if (values) sampled.set(key(t.schema, t.name, c.name), values);
        } catch {
          // Best-effort: a bad column just gets no samples.
        }
      }
    }
    if (sampled.size === 0) return catalog;
    return {
      ...catalog,
      tables: catalog.tables.map((t) => ({
        ...t,
        columns: t.columns.map((c) => {
          const values = sampled.get(key(t.schema, t.name, c.name));
          return values ? { ...c, sampledValues: values } : c;
        }),
      })),
    };
  }

  /**
   * Distinct values of one short text column, or undefined when it is not
   * categorical (too many distinct values, or any value is long).
   */
  private async sampleColumn(schema: string | undefined, table: string, column: string): Promise<string[] | undefined> {
    const rel = schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table);
    const reader = await this.connection().runAndReadUntil(
      `SELECT DISTINCT ${quoteIdent(column)} AS v FROM ${rel} ` +
        `WHERE ${quoteIdent(column)} IS NOT NULL LIMIT ${VALUE_SAMPLE_MAX_DISTINCT + 1}`,
      VALUE_SAMPLE_MAX_DISTINCT + 1,
    );
    const rows = reader.getRowObjects();
    if (rows.length > VALUE_SAMPLE_MAX_DISTINCT) return undefined;
    const vals: string[] = [];
    for (const r of rows) {
      if (r['v'] == null) continue;
      const s = String(r['v']);
      if (s.length > MAX_SAMPLE_VALUE_LEN) return undefined;
      vals.push(s);
    }
    return vals.length > 0 ? vals : undefined;
  }

  async execute(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
    // One query at a time: the connection is shared, so a queued query's interrupt would kill
    // the running one. A query waiting here holds no connection, so its abort is free.
    const run = this.queue.then(
      () => this.runQuery(sql, opts),
      () => this.runQuery(sql, opts),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runQuery(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
    const conn = this.connection();
    const maxRows = opts?.maxRows ?? 1000;
    const started = Date.now();
    let reader: DuckReader;
    try {
      // prepare() compiles exactly one statement; run()/runAndReadUntil() execute a whole multi-statement string.
      const prepared = await conn.prepare(sql);
      // Bounded read: fetch at most maxRows+1 rows.
      reader = await withQueryTimeout(
        prepared.runAndReadUntil(maxRows + 1),
        opts?.timeoutMs ?? 30_000,
        opts?.signal,
        () => conn.interrupt?.(),
      );
    } catch (err) {
      throw mapQueryError(err);
    }

    const names = reader.columnNames();
    const typeStrings = safeTypeStrings(reader, names.length);
    const columns = buildResultColumns(names, typeStrings);
    // Positional rows: getRowObjects() collapses duplicate column names (a JOIN's two `id`s); getRows() doesn't.
    const rawRows = reader.getRows();
    const truncated = rawRows.length > maxRows;
    const clipped = truncated ? rawRows.slice(0, maxRows) : rawRows;
    const rows = clipped.map((r) => r.map((v, i) => shapeDuckValue(v, columns[i]!.kind)));
    return { columns, rows, rowCount: rows.length, truncated, durationMs: Date.now() - started, warnings: [] };
  }

  async explain(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    return this.execute(`EXPLAIN ${sql}`, opts);
  }
}

function safeTypeStrings(reader: DuckReader, count: number): string[] {
  try {
    const types = reader.columnTypes?.() ?? [];
    return Array.from({ length: count }, (_, i) => types[i]?.toString?.() ?? 'unknown');
  } catch {
    return Array.from({ length: count }, () => 'unknown');
  }
}
