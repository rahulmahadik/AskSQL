/**
 * @asksql/duckdb/browser - the zero-backend, in-browser DuckDB connector.
 *
 * Runs entirely in the tab via `@duckdb/duckdb-wasm`: the user drops a CSV /
 * JSON / Parquet, it's registered in DuckDB's virtual filesystem (large files
 * stream from the File handle - never read into a JS string), queried in a Web
 * Worker, and never leaves the browser. Pairs with `LocalTransport` +
 * `createAskSql` so the whole ask->SQL->results loop is client-side.
 *
 * `@duckdb/duckdb-wasm` is an optional peer, imported lazily. This module is
 * browser-only (Web Worker + WASM); import it from client bundles, not Node.
 */

import {
  AskSqlError,
  DUCKDB_DIALECT,
  type Connector,
  type ExecuteOptions,
  type ResultColumn,
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
  sqlStr,
  uniqueTableName,
  validateSqlDump,
  withQueryTimeout,
  type FileFormat,
} from './shared.js';

/** A file to register from the browser. Provide `data` (content), not a path. */
export interface BrowserFileSource {
  readonly table: string;
  /** The uploaded content: a File/Blob (streamed), ArrayBuffer, or text. */
  readonly data: Blob | ArrayBuffer | Uint8Array | string;
  readonly format?: FileFormat;
  readonly encoding?: string;
  /** Original filename, used to infer format when `format` is omitted. */
  readonly filename?: string;
  /**
   * Excel worksheet to read (by name). Only used for `xlsx`; defaults to the
   * first sheet. Register the same workbook once per sheet with distinct
   * `table` names to query (and join) multiple sheets.
   */
  readonly sheet?: string;
}

export interface DuckDbWasmConnectorConfig {
  readonly id: string;
  readonly name: string;
  /**
   * DuckDB-WASM bundles. Omit to use the jsDelivr CDN (needs network + a CSP
   * that allows it). Provide self-hosted bundle URLs for offline / strict CSP.
   */
  readonly bundles?: DuckDbBundles;
  readonly files?: readonly BrowserFileSource[];
  /**
   * OPFS path (e.g. `opfs://asksql.db`) to back the database with the Origin
   * Private File System, so persistent tables survive a page reload.
   * Omit for an in-memory database. Note: file *views* are session-scoped;
   * materialize into a table (CREATE TABLE) to persist uploaded data.
   */
  readonly persistPath?: string;
}

export interface DuckDbBundle {
  readonly mainModule: string;
  readonly mainWorker: string;
  readonly pthreadWorker?: string;
}
export type DuckDbBundles = Record<string, DuckDbBundle>;

interface WasmModule {
  getJsDelivrBundles(): DuckDbBundles;
  selectBundle(bundles: DuckDbBundles): Promise<DuckDbBundle>;
  ConsoleLogger: new () => unknown;
  AsyncDuckDB: new (logger: unknown, worker: Worker) => WasmDb;
  DuckDBDataProtocol: { BROWSER_FILEREADER: number };
  DuckDBAccessMode?: { READ_WRITE: number };
}
interface WasmDb {
  instantiate(mainModule: string, pthreadWorker?: string): Promise<void>;
  open(config: { path: string; accessMode?: number }): Promise<void>;
  connect(): Promise<WasmConn>;
  registerFileHandle(name: string, handle: unknown, protocol: number, directIO: boolean): Promise<void>;
  registerFileBuffer(name: string, buffer: Uint8Array): Promise<void>;
  registerFileText(name: string, text: string): Promise<void>;
  terminate(): Promise<void>;
}
interface WasmConn {
  query(sql: string): Promise<ArrowTable>;
  send(sql: string): Promise<AsyncBatchReader>;
  close(): Promise<void>;
}
interface ArrowField {
  name: string;
  type: { toString(): string };
}
// Arrow's `toArray` is a method in current builds (older ones exposed a
// property); `arrowRows` tolerates both so a version bump can't break reads.
type ArrowToArray = (() => Record<string, unknown>[]) | Record<string, unknown>[];
interface ArrowTable {
  schema: { fields: ArrowField[] };
  toArray: ArrowToArray;
  numRows: number;
}
type ArrowBatch = {
  schema: { fields: ArrowField[] };
  toArray: ArrowToArray;
  // Positional column access on real Arrow batches; keeps duplicate column names toArray() collapses.
  numRows?: number;
  getChildAt?(i: number): { get(row: number): unknown } | null;
};
type AsyncBatchReader = AsyncIterable<ArrowBatch>;

function arrowRows(t: { toArray: ArrowToArray }): Record<string, unknown>[] {
  return typeof t.toArray === 'function' ? t.toArray() : t.toArray;
}

/** Rows as positional arrays (preserving duplicate column names), via Arrow column access when present. */
function positionalRows(batch: ArrowBatch, colCount: number): unknown[][] {
  if (typeof batch.getChildAt === 'function' && typeof batch.numRows === 'number') {
    const cols = Array.from({ length: colCount }, (_v, i) => batch.getChildAt!(i));
    const out: unknown[][] = [];
    for (let r = 0; r < batch.numRows; r++) out.push(cols.map((c) => (c ? c.get(r) : null)));
    return out;
  }
  const names = batch.schema.fields.map((f) => f.name);
  return arrowRows(batch).map((row) => names.map((n) => row[n]));
}

/** Decode uploaded .sql content (File/Blob/buffer/text) to a string. */
async function readAsText(data: Blob | ArrayBuffer | Uint8Array | string): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return data.text();
}

export class DuckDbWasmConnector implements Connector {
  readonly engine = 'duckdb' as const;
  readonly dialect = DUCKDB_DIALECT;
  readonly capabilities = DUCK_CAPABILITIES;
  readonly id: string;
  readonly name: string;

  private wasm: WasmModule | null = null;
  private db: WasmDb | null = null;
  private conn: WasmConn | null = null;
  private excelLoaded = false;
  private readonly registered = new Set<string>();

  constructor(private readonly config: DuckDbWasmConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
  }

  private async mod(): Promise<WasmModule> {
    if (this.wasm) return this.wasm;
    try {
      this.wasm = (await import('@duckdb/duckdb-wasm')) as unknown as WasmModule;
      return this.wasm;
    } catch (err) {
      throw new AskSqlError('WASM_LOAD', {
        detail: `cannot import @duckdb/duckdb-wasm: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: 'The in-browser analysis engine could not be loaded. Run: npm install @duckdb/duckdb-wasm',
        cause: err,
      });
    }
  }

  async connect(): Promise<void> {
    if (this.conn) return;
    const duckdb = await this.mod();
    try {
      const bundles = this.config.bundles ?? duckdb.getJsDelivrBundles();
      const bundle = await duckdb.selectBundle(bundles);
      const worker = new Worker(bundle.mainWorker);
      const logger = new duckdb.ConsoleLogger();
      this.db = new duckdb.AsyncDuckDB(logger, worker);
      await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      // OPFS-backed persistence: open the DB against an OPFS file so
      // persistent tables survive a reload.
      if (this.config.persistPath) {
        await this.db.open({
          path: this.config.persistPath,
          accessMode: duckdb.DuckDBAccessMode?.READ_WRITE ?? 3,
        });
      }
      this.conn = await this.db.connect();
    } catch (err) {
      throw new AskSqlError('WASM_LOAD', {
        detail: err instanceof Error ? err.message : String(err),
        userMessage: 'The in-browser analysis engine failed to start. Check your network and browser settings (CSP).',
        cause: err,
      });
    }
    for (const f of this.config.files ?? []) await this.registerFile(f);
  }

  async close(): Promise<void> {
    try {
      await this.conn?.close();
      await this.db?.terminate();
    } catch {
      /* nothing actionable on close */
    }
    this.conn = null;
    this.db = null;
  }

  private connection(): WasmConn {
    if (!this.conn) throw new AskSqlError('WASM_LOAD', { detail: 'duckdb-wasm not connected' });
    return this.conn;
  }

  registeredTables(): readonly string[] {
    return [...this.registered];
  }

  /**
   * Register uploaded content as a queryable view. A File/Blob is registered
   * via a file handle so DuckDB streams from it (large uploads never enter a
   * JS string); ArrayBuffer/text are registered as buffers. Duplicate names
   * are versioned. Returns the actual table name used.
   */
  async registerFile(file: BrowserFileSource): Promise<string> {
    const duckdb = await this.mod();
    const db = this.db;
    const conn = this.connection();
    if (!db) throw new AskSqlError('WASM_LOAD', { detail: 'db not initialized' });

    const format = resolveFormat({
      table: file.table,
      path: file.filename ?? file.table,
      format: file.format,
    });
    // A .sql file is executed to build its own tables, not read as one table.
    if (format === 'sql') return this.registerSqlDump(file);
    const table = uniqueTableName(sanitizeTableName(file.table), this.registered);
    const vfsName = `${table}.${format}`;

    try {
      if (typeof file.data === 'string') {
        await db.registerFileText(vfsName, file.data);
      } else if (file.data instanceof Uint8Array) {
        await db.registerFileBuffer(vfsName, file.data);
      } else if (file.data instanceof ArrayBuffer) {
        await db.registerFileBuffer(vfsName, new Uint8Array(file.data));
      } else {
        // Blob / File - stream via a file handle (memory-safe for big files).
        await db.registerFileHandle(vfsName, file.data, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      }

      if (format === 'xlsx' && !this.excelLoaded) {
        await conn.query('INSTALL excel; LOAD excel;');
        this.excelLoaded = true;
      }
      const reader = readerFor({ table, path: vfsName, encoding: file.encoding, sheet: file.sheet }, format);
      await conn.query(`CREATE VIEW ${quoteIdent(table)} AS SELECT * FROM ${reader}`);
      this.registered.add(table);
      return table;
    } catch (err) {
      throw mapFileError({ table: file.table, path: file.filename ?? file.table }, err);
    }
  }

  /**
   * Load a portable .sql dump (CREATE TABLE + INSERT) uploaded from the browser
   * and expose the tables it creates. Vendor dumps (mysqldump / pg_dump) and
   * file/network statements are rejected with a clear message before running.
   */
  private async registerSqlDump(file: BrowserFileSource): Promise<string> {
    const conn = this.connection();
    const content = await readAsText(file.data);
    validateSqlDump(content);
    const before = await this.tableNames();
    try {
      await conn.query(content);
    } catch (err) {
      throw mapFileError({ table: file.table, path: file.filename ?? file.table }, err);
    }
    const created = [...(await this.tableNames())].filter((t) => !before.has(t));
    if (created.length === 0) {
      throw new AskSqlError('FILE_PARSE', {
        detail: 'sql upload created no tables',
        userMessage: `"${file.filename ?? file.table}" ran but created no tables. An uploadable SQL file must CREATE TABLE and INSERT its data.`,
      });
    }
    for (const t of created) this.registered.add(t);
    return created[0]!;
  }

  private async tableNames(): Promise<Set<string>> {
    const rows = arrowRows(
      await this.connection().query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"),
    );
    return new Set(rows.map((r) => String(r['table_name'])));
  }

  async unregisterFile(table: string): Promise<void> {
    const name = sanitizeTableName(table);
    if (!this.registered.has(name)) return;
    await this.connection()
      .query(`DROP VIEW IF EXISTS ${quoteIdent(name)}`)
      .catch(() => {});
    await this.connection()
      .query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`)
      .catch(() => {});
    this.registered.delete(name);
  }

  async introspect(): Promise<SchemaCatalog> {
    const conn = this.connection();
    const warnings: string[] = [];
    let columnRows: Record<string, unknown>[] = [];
    try {
      columnRows = arrowRows(await conn.query(INTROSPECT_COLUMNS_SQL));
    } catch (err) {
      warnings.push(`Could not introspect columns: ${err instanceof Error ? err.message : String(err)}`);
    }
    let viewNames = new Set<string>();
    try {
      viewNames = new Set(arrowRows(await conn.query(INTROSPECT_VIEWS_SQL)).map((r) => String(r['table_name'])));
    } catch {
      /* optional */
    }
    return buildDuckCatalog(columnRows, viewNames, this.registered, warnings);
  }

  async execute(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
    const conn = this.connection();
    const maxRows = opts?.maxRows ?? 1000;
    const started = Date.now();

    try {
      // Bounded read: stream record batches and stop once we have maxRows+1
      // rows, so `SELECT *` over a huge file never materializes everything.
      const { columns, rows, truncated } = await withQueryTimeout(
        readBounded(conn, sql, maxRows),
        opts?.timeoutMs ?? 30_000,
        opts?.signal,
      );
      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - started,
        warnings: [],
      };
    } catch (err) {
      throw mapQueryError(err);
    }
  }

  async explain(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    return this.execute(`EXPLAIN ${sql}`, opts);
  }
}

async function readBounded(
  conn: WasmConn,
  sql: string,
  maxRows: number,
): Promise<{ columns: ResultColumn[]; rows: ResultSet['rows']; truncated: boolean }> {
  const reader = await conn.send(sql);
  const collected: unknown[][] = [];
  let fields: ArrowField[] = [];
  for await (const batch of reader) {
    if (fields.length === 0) fields = batch.schema.fields;
    for (const row of positionalRows(batch, fields.length)) {
      collected.push(row);
      if (collected.length > maxRows) break;
    }
    if (collected.length > maxRows) break;
  }
  const names = fields.map((f) => f.name);
  const types = fields.map((f) => f.type.toString());
  const columns = buildResultColumns(names, types);
  const truncated = collected.length > maxRows;
  const clipped = truncated ? collected.slice(0, maxRows) : collected;
  const rows = clipped.map((r) => r.map((v, i) => shapeDuckValue(v, columns[i]!.kind)));
  return { columns, rows, truncated };
}
