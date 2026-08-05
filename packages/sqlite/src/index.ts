/**
 * @asksql/sqlite - SQLite connector. Driver-agnostic: pass a `better-sqlite3` instance, a
 * built-in `node:sqlite` DatabaseSync, or a file path. SQLite has no schemas, so
 * introspection is PRAGMA-based. Queries are synchronous in both drivers, so timeouts and
 * cancellation are cooperative: a pre-flight abort check and a row cap, no mid-statement stop.
 */

import {
  AskSqlError,
  SQLITE_DIALECT,
  VALUE_SAMPLE_MAX_DISTINCT,
  type CapabilityFlags,
  type CellValue,
  type ColumnInfo,
  type Connector,
  type ExecuteOptions,
  type ForeignKeyInfo,
  type IndexInfo,
  type ResultColumn,
  type ResultSet,
  type SchemaCatalog,
  type TableInfo,
  type TriggerInfo,
} from '@asksql/core';

/** A prepared statement; `raw`/`columns` read rows positionally, keeping duplicate output names distinct. */
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get?(...params: unknown[]): unknown;
  /** better-sqlite3: switch this statement to positional array rows. */
  raw?(toggle?: boolean): SqliteStatement;
  /** Result-column metadata in order; `.name` is the (alias-aware) output name. */
  columns?(): { name: string }[];
  /** better-sqlite3: read INTEGER columns as BigInt so 64-bit values keep full precision. */
  safeIntegers?(toggle?: boolean): SqliteStatement;
  /** node:sqlite: the equivalent BigInt read toggle. */
  setReadBigInts?(readBigInts: boolean): void;
}

/** Minimal driver surface satisfied by better-sqlite3 and node:sqlite. */
export interface SqliteDriver {
  prepare(sql: string): SqliteStatement;
  exec?(sql: string): void;
  close?(): void;
}

export interface SqliteConnectorConfig {
  readonly id: string;
  readonly name: string;
  /** Provide an existing driver instance... */
  readonly database?: SqliteDriver;
  /** ...or a file path (lazy-loads better-sqlite3, opened read-only). */
  readonly file?: string;
  /** Opt-in: sample distinct values from short text columns, so the model sees the real codes a `status TEXT` holds. */
  readonly sampleColumnValues?: boolean;
}

const CAPABILITIES: CapabilityFlags = {
  supportsCancel: false,
  supportsExplain: true,
  supportsSchemas: false,
  readOnlySession: true,
  supportsMatViews: false,
  supportsTriggers: true,
  supportsRoutines: false,
};

// Value sampling (opt-in) guards.
const MAX_SAMPLED_COLUMNS = 300;
const MAX_SAMPLE_VALUE_LEN = 64;

/** SQLite TEXT-affinity types (declared type contains CHAR/CLOB/TEXT). */
function isSampleableSqliteType(dbType: string): boolean {
  return /char|clob|text/i.test(dbType);
}

export class SqliteConnector implements Connector {
  readonly engine = 'sqlite' as const;
  readonly dialect = SQLITE_DIALECT;
  readonly capabilities = CAPABILITIES;
  readonly id: string;
  readonly name: string;
  readonly database?: string;
  private db: SqliteDriver | null = null;
  /** Set once the handle in use has been proven read-only, so the check runs once per handle. */
  private readOnlyAsserted = false;

  /** `query_only` as a caller-supplied handle arrived, so close() can restore it. */
  private restoreQueryOnly: boolean | null = null;

  constructor(private readonly config: SqliteConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
    // Display hint: the file's base name (a passed-in handle has no name).
    this.database = config.file ? config.file.split(/[\\/]/).pop() || undefined : undefined;
    this.db = config.database ?? null;
  }

  async connect(): Promise<void> {
    if (this.db) {
      // A caller-supplied handle was opened by the host, so verify its read-only state here once.
      if (!this.readOnlyAsserted) this.assertReadOnly(this.db);
      return;
    }
    if (!this.config.file) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: 'SqliteConnector needs either `database` or `file`',
        userMessage: 'No SQLite database was configured.',
      });
    }
    // Load the driver and open the file in separate steps, so each failure gets its own message.
    let Ctor: new (f: string, o?: object) => SqliteDriver;
    let openOptions: object = { readonly: true, fileMustExist: true };
    let betterSqliteError: unknown;
    try {
      // Indirect specifier: better-sqlite3 ships no types, so this keeps the type-checker
      // from resolving its declarations at build time.
      const specifier = 'better-sqlite3';
      const mod = (await import(specifier)) as unknown as { default: new (f: string, o?: object) => SqliteDriver };
      Ctor = mod.default;
    } catch (err) {
      betterSqliteError = err;
      try {
        // Node ships a SQLite driver from 22.5, so this fallback needs no native module.
        const builtin = (await import('node:sqlite')) as unknown as {
          DatabaseSync: new (f: string, o?: object) => SqliteDriver;
        };
        Ctor = builtin.DatabaseSync;
        // node:sqlite spells the flag differently and errors on a missing file already.
        openOptions = { readOnly: true };
      } catch {
        throw new AskSqlError('CONFIG_ERROR', {
          detail: `sqlite driver not available: ${betterSqliteError instanceof Error ? betterSqliteError.message : String(betterSqliteError)}`,
          userMessage:
            'No SQLite driver is available. Use Node 22.5 or newer (which has one built in), ' +
            'or run: npm install better-sqlite3',
          cause: betterSqliteError,
        });
      }
    }
    let opened: SqliteDriver;
    try {
      opened = new Ctor(this.config.file, openOptions);
    } catch (err) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `cannot open sqlite file "${this.config.file}": ${err instanceof Error ? err.message : String(err)}`,
        userMessage: `Could not open the SQLite database file "${this.config.file}". Check that the path is correct and the file exists.`,
        cause: err,
      });
    }
    // Publish the handle only once it has proven read-only.
    try {
      this.assertReadOnly(opened);
    } catch (err) {
      opened.close?.();
      throw err; // already the precise read-only diagnostic
    }
    this.db = opened;
  }

  /**
   * node:sqlite ignores option keys it does not recognise, so a wrong open flag yields a
   * read-write handle with no error. `PRAGMA query_only` is set and read back instead.
   */
  private assertReadOnly(db: SqliteDriver): void {
    const queryOnly = (): boolean => {
      const rows = db.prepare('PRAGMA query_only').all() as Record<string, unknown>[];
      return rows.length > 0 && Object.values(rows[0]!).some((v) => v === 1 || v === 1n || v === true);
    };
    // `query_only` belongs to the connection, so remember a caller-supplied handle's flag for close().
    if (this.config.database && this.restoreQueryOnly === null) this.restoreQueryOnly = queryOnly();
    try {
      db.exec?.('PRAGMA query_only = ON');
    } catch {
      // Some drivers refuse exec() on a read-only handle; the read-back below is the real check.
    }
    if (!queryOnly()) {
      const supplied = !this.config.file;
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `sqlite connection for ${supplied ? 'the supplied database handle' : `"${this.config.file}"`} could not be put into read-only mode`,
        userMessage: supplied
          ? 'The SQLite handle passed to AskSQL could not be put into read-only mode, so AskSQL will not use it.'
          : 'This SQLite database could not be opened read-only, so AskSQL will not use it. ' +
            'Update Node (22.5 or newer) or install better-sqlite3.',
      });
    }
    this.readOnlyAsserted = true;
  }

  async close(): Promise<void> {
    // Only close a handle we opened ourselves.
    if (this.db && this.config.file && !this.config.database) this.db.close?.();
    if (!this.config.database) {
      this.db = null;
      this.readOnlyAsserted = false;
      return;
    }
    // Give the caller's connection back as it was: if it could write before, it can write again.
    if (this.restoreQueryOnly === false) {
      try {
        this.db?.exec?.('PRAGMA query_only = OFF');
      } catch {
        // Nothing useful to do; the handle is the caller's and may already be closed.
      }
    }
    this.restoreQueryOnly = null;
    this.readOnlyAsserted = false;
  }

  private handle(): SqliteDriver {
    if (!this.db) throw new AskSqlError('DB_UNREACHABLE', { detail: 'sqlite not connected' });
    // A caller-supplied handle reaches `this.db` from the constructor, ahead of any read-only check.
    if (!this.readOnlyAsserted) {
      throw new AskSqlError('DB_UNREACHABLE', {
        detail: 'sqlite handle has not been verified read-only; connect() must run first',
        userMessage: 'The SQLite connection is not ready yet.',
      });
    }
    return this.db;
  }

  private rows(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    try {
      return this.handle()
        .prepare(sql)
        .all(...params) as Record<string, unknown>[];
    } catch (err) {
      // A connection-state error is already precise; only a driver error becomes a query error.
      if (err instanceof AskSqlError) throw err;
      throw AskSqlError.from(err, 'DB_QUERY_ERROR');
    }
  }

  /**
   * Distinct values of one short text column, or undefined when it is not
   * categorical (too many distinct values, or any value is long).
   */
  private sampleColumn(table: string, column: string): string[] | undefined {
    const rows = this.rows(
      `SELECT DISTINCT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} ` +
        `WHERE ${quoteIdent(column)} IS NOT NULL LIMIT ${VALUE_SAMPLE_MAX_DISTINCT + 1}`,
    );
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

  async introspect(): Promise<SchemaCatalog> {
    const warnings: string[] = [];
    const objs = this.rows(
      `SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const tables: TableInfo[] = [];
    const triggers: TriggerInfo[] = [];
    let sampleBudget = MAX_SAMPLED_COLUMNS;

    for (const o of objs) {
      const name = String(o['name']);
      const type = String(o['type']);
      const ddl = o['sql'] == null ? null : String(o['sql']);
      if (type === 'trigger') {
        const def = ddl ?? '';
        const timing = /\bBEFORE\b/i.test(def)
          ? 'BEFORE'
          : /\bAFTER\b/i.test(def)
            ? 'AFTER'
            : /\bINSTEAD OF\b/i.test(def)
              ? 'INSTEAD OF'
              : 'UNKNOWN';
        const events: string[] = [];
        for (const ev of ['INSERT', 'UPDATE', 'DELETE']) if (new RegExp(`\\b${ev}\\b`, 'i').test(def)) events.push(ev);
        const tblMatch = /\bON\s+["'`]?(\w+)["'`]?/i.exec(def);
        triggers.push({ name, table: tblMatch?.[1] ?? '', timing, events, enabled: true, definition: def });
        continue;
      }
      let cols: Record<string, unknown>[] = [];
      let fks: Record<string, unknown>[] = [];
      let idxList: Record<string, unknown>[] = [];
      try {
        cols = this.rows(`PRAGMA table_info(${quoteIdent(name)})`);
        fks = this.rows(`PRAGMA foreign_key_list(${quoteIdent(name)})`);
        idxList = this.rows(`PRAGMA index_list(${quoteIdent(name)})`);
      } catch (err) {
        warnings.push(`Could not introspect ${name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      let columns: ColumnInfo[] = cols.map((c) => ({
        name: String(c['name']),
        dbType: String(c['type'] || 'TEXT'),
        nullable: Number(c['notnull']) === 0,
        default: c['dflt_value'] == null ? null : String(c['dflt_value']),
      }));
      // Opt-in: observe the distinct codes a short text column holds; base tables only, as sampling a view runs its query.
      if (this.config.sampleColumnValues && type !== 'view') {
        columns = columns.map((col) => {
          if (sampleBudget <= 0 || !isSampleableSqliteType(col.dbType)) return col;
          sampleBudget--;
          try {
            const sampled = this.sampleColumn(name, col.name);
            return sampled ? { ...col, sampledValues: sampled } : col;
          } catch {
            // Best-effort: a bad column just gets no samples.
            return col;
          }
        });
      }
      const primaryKey = cols
        .filter((c) => Number(c['pk']) > 0)
        .sort((a, b) => Number(a['pk']) - Number(b['pk']))
        .map((c) => String(c['name']));
      const foreignKeys: ForeignKeyInfo[] = groupFks(fks);
      const indexes: IndexInfo[] = idxList.map((ix) => {
        const idxName = String(ix['name']);
        let idxCols: string[] = [];
        try {
          idxCols = this.rows(`PRAGMA index_info(${quoteIdent(idxName)})`).map((r) => String(r['name']));
        } catch {
          /* best-effort */
        }
        return { name: idxName, columns: idxCols, unique: Number(ix['unique']) === 1 };
      });
      tables.push({
        name,
        kind: type === 'view' ? 'view' : 'table',
        columns,
        primaryKey,
        foreignKeys,
        uniques: indexes.filter((i) => i.unique).map((i) => i.columns),
        checks: [],
        indexes,
        definition: ddl,
        source: 'db',
      });
    }

    return {
      engine: 'sqlite',
      schemas: ['main'],
      tables,
      enums: [],
      sequences: [],
      triggers,
      routines: [],
      warnings,
      fetchedAt: new Date().toISOString(),
    };
  }

  async execute(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
    const maxRows = opts?.maxRows ?? 1000;
    const started = Date.now();
    const warnings: string[] = [];

    let colNames: string[] = [];
    let valueRows: unknown[][];
    try {
      const stmt = this.handle().prepare(sql);
      // Read integers as BigInt so 64-bit values aren't truncated to a lossy JS number; shapeSqliteValue narrows safe ones back.
      stmt.safeIntegers?.(true);
      stmt.setReadBigInts?.(true);
      const meta = typeof stmt.columns === 'function' ? stmt.columns() : null;
      if (meta && typeof stmt.raw === 'function') {
        // Positional rows keep duplicate column names distinct (object rows collapse them).
        stmt.raw(true);
        colNames = meta.map((c) => String(c.name));
        valueRows = stmt.all() as unknown[][];
      } else {
        const objRows = stmt.all() as Record<string, unknown>[];
        colNames = meta ? meta.map((c) => String(c.name)) : objRows.length > 0 ? Object.keys(objRows[0]!) : [];
        valueRows = objRows.map((r) => colNames.map((name) => r[name]));
        if (meta && new Set(colNames).size !== colNames.length) {
          warnings.push(
            'Two result columns share a name, so only one value is shown for them. Add column aliases (AS) to tell them apart.',
          );
        }
      }
    } catch (err) {
      // A connection-state error is already precise; only a driver error becomes a query error.
      if (err instanceof AskSqlError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/readonly|attempt to write a readonly database/i.test(msg)) {
        throw new AskSqlError('GUARD_BLOCKED', {
          userMessage: 'Blocked for safety: the database is read-only.',
          detail: msg,
          cause: err,
        });
      }
      throw new AskSqlError('DB_QUERY_ERROR', {
        userMessage: `The query failed: ${msg.slice(0, 200)}`,
        detail: msg,
        cause: err,
      });
    }

    const truncated = valueRows.length > maxRows;
    const clipped = truncated ? valueRows.slice(0, maxRows) : valueRows;
    // SQLite exposes no result-column types; infer each kind from the column's first non-null value.
    const columns: ResultColumn[] = colNames.map((name, i) => ({
      name,
      kind: inferKind(clipped.find((r) => r[i] != null)?.[i]),
    }));
    const rows = clipped.map((r) => colNames.map((_, i) => shapeSqliteValue(r[i])));
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - started,
      warnings,
    };
  }

  async explain(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    return this.execute(`EXPLAIN QUERY PLAN ${sql}`, opts);
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function groupFks(fks: Record<string, unknown>[]): ForeignKeyInfo[] {
  const byId = new Map<number, { cols: string[]; refCols: string[]; table: string }>();
  for (const f of fks) {
    const id = Number(f['id']);
    let g = byId.get(id);
    if (!g) byId.set(id, (g = { cols: [], refCols: [], table: String(f['table']) }));
    g.cols.push(String(f['from']));
    g.refCols.push(String(f['to']));
  }
  return [...byId.values()].map((g) => ({ columns: g.cols, refTable: g.table, refColumns: g.refCols }));
}

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
/** A BigInt that round-trips through a JS number losslessly. */
const fitsJsNumber = (v: bigint): boolean => v >= MIN_SAFE_BIGINT && v <= MAX_SAFE_BIGINT;

function inferKind(sample: unknown): ResultColumn['kind'] {
  if (typeof sample === 'bigint') return fitsJsNumber(sample) ? 'number' : 'bigint';
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'boolean';
  if (sample instanceof Uint8Array || Buffer.isBuffer(sample)) return 'binary';
  if (typeof sample === 'string') return 'text';
  return 'unknown';
}

function shapeSqliteValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  // Narrow to number when it fits; keep a genuine 64-bit value as a string so precision is not lost.
  if (typeof v === 'bigint') return fitsJsNumber(v) ? Number(v) : v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.from(v as Uint8Array);
    return { __binary: { bytes: buf.length, hexPreview: buf.subarray(0, 16).toString('hex') } };
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}
