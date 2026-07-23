/**
 * @asksql/duckdb - DuckDB connector (Node, the zero-backend file path).
 *
 * Registers uploaded files (CSV / JSON / NDJSON / Parquet / Excel) as views,
 * then answers questions over them. Files become named views so the model
 * never sees a filesystem path. Large files are streamed (a view over
 * the reader, plus a bounded read) so they never materialize in memory.
 *
 * This is the Node build (native `@duckdb/node-api`). The browser build is
 * `@asksql/duckdb/browser` (`@duckdb/duckdb-wasm`) and shares `./shared.ts`.
 */

import {
  AskSqlError,
  DUCKDB_DIALECT,
  VALUE_SAMPLE_MAX_DISTINCT,
  type Connector,
  type ExecuteOptions,
  type ResultSet,
  type SchemaCatalog,
} from '@asksql/core';
import { readFile } from 'node:fs/promises';
import {
  assertSafeFilePath,
  buildDuckCatalog,
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
  /**
   * Opt-in: sample distinct values from short text columns, so the model sees the
   * real codes a `status VARCHAR` holds. This reads actual cell values (not just
   * schema), so it is off unless the caller sets it.
   */
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

  constructor(private readonly config: DuckDbConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
    // Display hint: the database file's base name, or in-memory when none.
    this.database = config.path ? config.path.split(/[\\/]/).pop() || undefined : 'in-memory';
  }

  private async api(): Promise<{ DuckDBInstance: { create(path?: string): Promise<DuckInstance> } }> {
    try {
      return (await import('@duckdb/node-api')) as unknown as {
        DuckDBInstance: { create(path?: string): Promise<DuckInstance> };
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
    this.instance = await DuckDBInstance.create(this.config.path ?? ':memory:');
    this.conn = await this.instance.connect();
    // Engine-level defense-in-depth. DuckDB has no read-only session, so the
    // guard is the only barrier - and its denylist cannot cover DuckDB's open
    // extension surface. Turning OFF implicit extension autoload/autoinstall
    // means the dangerous families (httpfs http_*, postgres/mysql/sqlite
    // scanners, spatial st_read*, gsheets) cannot load behind the guard's back:
    // a query that reaches for one errors instead of executing. Extensions we
    // need (excel for xlsx) are still loaded explicitly via INSTALL/LOAD.
    for (const stmt of ['SET autoinstall_known_extensions=false', 'SET autoload_known_extensions=false']) {
      try {
        await this.conn.run(stmt);
      } catch {
        // Older DuckDB may not expose these settings; the guard denylist still applies.
      }
    }
    for (const f of this.config.files ?? []) await this.registerFile(f);
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
   * Load a portable .sql dump (CREATE TABLE + INSERT) and expose the tables it
   * creates. Vendor dumps (mysqldump / pg_dump) and file/network statements are
   * rejected with a clear message BEFORE anything runs. Returns the first table
   * the script created.
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
    return this.config.sampleColumnValues ? this.attachSampledValues(catalog) : catalog;
  }

  /**
   * Opt-in: enrich short non-enum text columns with the distinct codes they hold.
   * Rebuilds the catalog immutably rather than mutating readonly column arrays.
   */
  private async attachSampledValues(catalog: SchemaCatalog): Promise<SchemaCatalog> {
    // NUL-join the key: identifiers may contain dots, so a plain "a.b.c" join
    // would collide (table "a.b" col "c" vs table "a" col "b.c").
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
    const conn = this.connection();
    const maxRows = opts?.maxRows ?? 1000;
    const started = Date.now();
    let reader: DuckReader;
    try {
      // prepare() is a security backstop: DuckDB has no read-only session and
      // runAndReadUntil would run multiple statements, so compiling exactly one
      // statement is the only structural defence. Do not switch to conn.run().
      const prepared = await conn.prepare(sql);
      // Bounded read: fetch at most maxRows+1 rows so `SELECT *` over a huge
      // file never materializes millions of JS objects.
      reader = await withQueryTimeout(prepared.runAndReadUntil(maxRows + 1), opts?.timeoutMs ?? 30_000, opts?.signal, () =>
        conn.interrupt?.(),
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
