/**
 * @asksql/sqlite - SQLite connector.
 *
 * Driver-agnostic: pass a `better-sqlite3` instance, a built-in
 * `node:sqlite` DatabaseSync, or a file path (lazy-loads better-sqlite3).
 * SQLite has no schemas; introspection is PRAGMA-based.
 *
 * Timeouts / cancellation are cooperative - SQLite queries are synchronous
 * in these drivers, so a pre-flight abort check is honored and long results
 * are capped, but mid-statement interruption is not available.
 */

import {
  AskSqlError,
  SQLITE_DIALECT,
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

/** Minimal driver surface satisfied by better-sqlite3 and node:sqlite. */
export interface SqliteDriver {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get?(...params: unknown[]): unknown;
  };
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

export class SqliteConnector implements Connector {
  readonly engine = 'sqlite' as const;
  readonly dialect = SQLITE_DIALECT;
  readonly capabilities = CAPABILITIES;
  readonly id: string;
  readonly name: string;
  private db: SqliteDriver | null = null;

  constructor(private readonly config: SqliteConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
    this.db = config.database ?? null;
  }

  async connect(): Promise<void> {
    if (this.db) return;
    if (!this.config.file) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: 'SqliteConnector needs either `database` or `file`',
        userMessage: 'No SQLite database was configured.',
      });
    }
    try {
      // Indirect specifier: better-sqlite3 is an optional peer with no
      // bundled types; the indirection keeps the type-checker from trying
      // to resolve its declarations at build time.
      const specifier = 'better-sqlite3';
      const mod = (await import(specifier)) as unknown as { default: new (f: string, o?: object) => SqliteDriver };
      const Ctor = mod.default;
      this.db = new Ctor(this.config.file, { readonly: true, fileMustExist: true });
    } catch (err) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `cannot open sqlite file: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: 'The SQLite driver is not installed. Run: npm install better-sqlite3',
        cause: err,
      });
    }
  }

  async close(): Promise<void> {
    // Only close a handle we opened ourselves.
    if (this.db && this.config.file && !this.config.database) this.db.close?.();
    if (!this.config.database) this.db = null;
  }

  private handle(): SqliteDriver {
    if (!this.db) throw new AskSqlError('DB_UNREACHABLE', { detail: 'sqlite not connected' });
    return this.db;
  }

  private rows(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    try {
      return this.handle().prepare(sql).all(...params) as Record<string, unknown>[];
    } catch (err) {
      throw AskSqlError.from(err, 'DB_QUERY_ERROR');
    }
  }

  async introspect(): Promise<SchemaCatalog> {
    const warnings: string[] = [];
    const objs = this.rows(
      `SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const tables: TableInfo[] = [];
    const triggers: TriggerInfo[] = [];

    for (const o of objs) {
      const name = String(o['name']);
      const type = String(o['type']);
      const ddl = o['sql'] == null ? null : String(o['sql']);
      if (type === 'trigger') {
        const def = ddl ?? '';
        const timing = /\bBEFORE\b/i.test(def) ? 'BEFORE' : /\bAFTER\b/i.test(def) ? 'AFTER' : /\bINSTEAD OF\b/i.test(def) ? 'INSTEAD OF' : 'UNKNOWN';
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
      const columns: ColumnInfo[] = cols.map((c) => ({
        name: String(c['name']),
        dbType: String(c['type'] || 'TEXT'),
        nullable: Number(c['notnull']) === 0,
        default: c['dflt_value'] == null ? null : String(c['dflt_value']),
      }));
      const primaryKey = cols.filter((c) => Number(c['pk']) > 0).sort((a, b) => Number(a['pk']) - Number(b['pk'])).map((c) => String(c['name']));
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
    let rawRows: Record<string, unknown>[];
    try {
      rawRows = this.handle().prepare(sql).all() as Record<string, unknown>[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/readonly|attempt to write a readonly database/i.test(msg)) {
        throw new AskSqlError('GUARD_BLOCKED', {
          userMessage: 'Blocked for safety: the database is read-only.',
          detail: msg,
          cause: err,
        });
      }
      throw new AskSqlError('DB_QUERY_ERROR', { userMessage: `The query failed: ${msg.slice(0, 200)}`, detail: msg, cause: err });
    }
    const truncated = rawRows.length > maxRows;
    const clipped = truncated ? rawRows.slice(0, maxRows) : rawRows;
    const colNames = clipped.length > 0 ? Object.keys(clipped[0]!) : [];
    // SQLite exposes no result-column types, so infer each kind from the first
    // non-null value in that column.
    const columns: ResultColumn[] = colNames.map((name) => ({
          name,
          kind: inferKind(clipped.find((r) => r[name] != null)?.[name]),
  }));
    const rows = clipped.map((r) => colNames.map((name) => shapeSqliteValue(r[name])));
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - started,
      warnings: [],
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

function inferKind(sample: unknown): ResultColumn['kind'] {
  if (typeof sample === 'bigint') return 'bigint';
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'boolean';
  if (sample instanceof Uint8Array || Buffer.isBuffer(sample)) return 'binary';
  if (typeof sample === 'string') return 'text';
  return 'unknown';
}

function shapeSqliteValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.from(v as Uint8Array);
    return { __binary: { bytes: buf.length, hexPreview: buf.subarray(0, 16).toString('hex') } };
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}
