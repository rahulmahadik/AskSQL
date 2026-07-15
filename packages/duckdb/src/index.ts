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
  type Connector,
  type ExecuteOptions,
  type ResultSet,
  type SchemaCatalog,
} from '@asksql/core';
import {
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
}

interface DuckPrepared {
  runAndReadUntil(targetRowCount: number): Promise<DuckReader>;
}
interface DuckConnection {
  run(sql: string): Promise<unknown>;
  runAndReadUntil(sql: string, targetRowCount: number): Promise<DuckReader>;
  /** Compiles exactly ONE statement; throws on a multi-statement string. */
  prepare(sql: string): Promise<DuckPrepared>;
  closeSync?(): void;
  disconnectSync?(): void;
}
interface DuckReader {
  getRowObjects(): Record<string, unknown>[];
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
  private instance: DuckInstance | null = null;
  private conn: DuckConnection | null = null;
  private excelLoaded = false;
  private readonly registered = new Set<string>();

  constructor(private readonly config: DuckDbConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
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
    for (const stmt of [
      'SET autoinstall_known_extensions=false',
      'SET autoload_known_extensions=false',
    ]) {
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
    const table = uniqueTableName(sanitizeTableName(file.table), this.registered);
    const format = resolveFormat(file);
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

/** Remove a previously registered file view. */
async unregisterFile(table: string): Promise<void> {
  const name = sanitizeTableName(table);
  if (!this.registered.has(name)) return;
  await this.connection().run(`DROP VIEW IF EXISTS ${quoteIdent(name)}`);
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
          userMessage: 'Excel support needs the DuckDB "excel" extension, which could not be loaded (offline?). Convert the file to CSV.',
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
      viewNames = new Set((await conn.runAndReadUntil(INTROSPECT_VIEWS_SQL, 100_000)).getRowObjects().map((r) => String(r['table_name'])));
    } catch {
      /* views are optional */
    }
  return buildDuckCatalog(columnRows, viewNames, this.registered, warnings);
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
      reader = await withQueryTimeout(prepared.runAndReadUntil(maxRows + 1), opts?.timeoutMs ?? 30_000, opts?.signal);
    } catch (err) {
      throw mapQueryError(err);
    }

    const names = reader.columnNames();
    const typeStrings = safeTypeStrings(reader, names.length);
    const columns = buildResultColumns(names, typeStrings);
    const rawRows = reader.getRowObjects();
    const truncated = rawRows.length > maxRows;
    const clipped = truncated ? rawRows.slice(0, maxRows) : rawRows;
    const rows = clipped.map((r) => names.map((name, i) => shapeDuckValue(r[name], columns[i]!.kind)));
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
