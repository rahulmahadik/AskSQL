/**
 * @asksql/mysql - MySQL connector.
 *
 * - information_schema introspection (tables, views, columns, PKs, FKs,
 * uniques, indexes, triggers, routines, enum column values) (INT-*).
 * - Read-only enforcement: each query runs in a `START TRANSACTION READ
 * ONLY` with `MAX_EXECUTION_TIME`.
 * - Cancellation via `KILL QUERY <connectionId>` from a side connection
 *.
 *
 * `mysql2` is a peer dependency, imported lazily.
 */

import {
  AskSqlError,
  MYSQL_DIALECT,
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
  type RoutineInfo,
  type SchemaCatalog,
  type TableInfo,
  type TriggerInfo,
} from '@asksql/core';

export interface MysqlConnectorConfig {
  readonly id: string;
  readonly name: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database: string;
  readonly uri?: string;
  readonly ssl?: Record<string, unknown>;
  readonly connectionLimit?: number;
  /**
   * Opt-in: sample distinct values from short text columns that are NOT declared
   * enums, so the model sees the real codes a `status VARCHAR` holds. This reads
   * actual cell values (not just schema), so it is off unless the caller sets it.
   */
  readonly sampleColumnValues?: boolean;
}

interface MysqlPool {
  getConnection(): Promise<MysqlConn>;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}
interface MysqlConn {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  release(): void;
  threadId?: number;
  connection?: { connectionId?: number };
}

const CAPABILITIES: CapabilityFlags = {
  supportsCancel: true,
  supportsExplain: true,
  supportsSchemas: true,
  readOnlySession: true,
  supportsMatViews: false,
  supportsTriggers: true,
  supportsRoutines: true,
};

// Value sampling (opt-in) guards: bound the per-column scan, the total number of
// columns probed per introspect, and how long a sampled value may be.
const SAMPLE_QUERY_TIMEOUT_MS = 2000;
const MAX_SAMPLED_COLUMNS = 300;
const MAX_SAMPLE_VALUE_LEN = 64;

/** Only fixed-length text is worth sampling; text/blob/json/enum/set are not. */
function isSampleableMysqlType(dbType: string): boolean {
  return /^(var)?char\s*\(/i.test(dbType.trim());
}

function backtick(ident: string): string {
  return `\`${ident.replace(/`/g, '``')}\``;
}

export class MysqlConnector implements Connector {
  readonly engine = 'mysql' as const;
  readonly dialect = MYSQL_DIALECT;
  readonly capabilities = CAPABILITIES;
  readonly id: string;
  readonly name: string;
  private pool: MysqlPool | null = null;
  private resolvedDb: string | undefined;

  constructor(private readonly config: MysqlConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
  }

  /**
   * The database to introspect. With discrete config this is config.database;
   * with a `uri` (DSN) the database is chosen by the connection string, so ask
   * the server which one is current instead of filtering information_schema on an
   * empty name (which would silently return zero tables). Cached after first look.
   */
  private async databaseName(): Promise<string> {
    if (this.config.database) return this.config.database;
    // Only cache a real name - never '' from a failed query or a db-less DSN.
    if (this.resolvedDb) return this.resolvedDb;
    const r = await this.q('SELECT DATABASE() AS d');
    const d = r[0]?.['d'];
    if (!d) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: 'connection selected no default database',
        userMessage: 'This connection string does not select a database. Add the database name to the URL, for example .../your_database.',
      });
    }
    this.resolvedDb = String(d);
    return this.resolvedDb;
  }

  private async driver(): Promise<{ createPool(o: object | string): MysqlPool }> {
    try {
      const mod = (await import('mysql2/promise')) as unknown as {
        createPool(o: object | string): MysqlPool;
        default?: { createPool(o: object | string): MysqlPool };
      };
      const createPool = mod.createPool ?? mod.default?.createPool;
      if (!createPool) throw new Error('mysql2 createPool not found');
      return { createPool };
    } catch (err) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `cannot import mysql2: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: 'The MySQL driver is not installed. Run: npm install mysql2',
        cause: err,
      });
    }
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    const { createPool } = await this.driver();
    const opts: Record<string, unknown> = this.config.uri
      ? { uri: this.config.uri }
      : {
          host: this.config.host ?? 'localhost',
          port: this.config.port ?? 3306,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
        };
    opts['connectionLimit'] = this.config.connectionLimit ?? 5;
    opts['dateStrings'] = true; // avoid TZ drift
    opts['decimalNumbers'] = false; // keep DECIMAL as string
    opts['supportBigNumbers'] = true;
    opts['bigNumberStrings'] = true;
    if (this.config.ssl) opts['ssl'] = this.config.ssl;
    // opts already carries `uri` in DSN mode; the raw string would drop these flags.
    this.pool = createPool(opts);
    try {
      const c = await this.pool.getConnection();
      c.release();
    } catch (err) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      throw mapConnectError(err);
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
    }
    // A reconnect (uri swap) may select a different db.
    this.resolvedDb = undefined;
  }

  private ensure(): MysqlPool {
    if (!this.pool) throw new AskSqlError('DB_UNREACHABLE', { detail: 'mysql not connected' });
    return this.pool;
  }

  private async q(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const pool = this.ensure();
    const [rows] = await pool.query(sql, params);
    return rows as Record<string, unknown>[];
  }

  /**
   * Distinct values of one short text column, or undefined when the column is
   * not categorical (too many distinct values, or any value is long). Bounded by
   * LIMIT + a MAX_EXECUTION_TIME hint so a big table cannot stall introspection.
   */
  private async sampleColumn(db: string, table: string, column: string): Promise<string[] | undefined> {
    const rows = await this.q(
      `SELECT /*+ MAX_EXECUTION_TIME(${SAMPLE_QUERY_TIMEOUT_MS}) */ DISTINCT ${backtick(column)} AS v ` +
        `FROM ${backtick(db)}.${backtick(table)} ` +
        `WHERE ${backtick(column)} IS NOT NULL LIMIT ${VALUE_SAMPLE_MAX_DISTINCT + 1}`,
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
    const db = await this.databaseName();
    const warnings: string[] = [];
    const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        warnings.push(`Could not read ${label}: ${err instanceof Error ? err.message : String(err)}`);
        return fallback;
      }
    };

    const cols = await safe('columns', () => this.q(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
              COLUMN_COMMENT, EXTRA, COLUMN_KEY
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [db],
    ), []);

    const tablesMeta = await safe('tables', () => this.q(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [db],
    ), []);

    const views = await safe('views', () => this.q(
      `SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`,
      [db],
    ), []);
    const viewDef = new Map(views.map((v) => [String(v['TABLE_NAME']), v['VIEW_DEFINITION'] == null ? null : String(v['VIEW_DEFINITION'])]));

    const keyCols = await safe('key columns', () => this.q(
      `SELECT TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      [db],
    ), []);

    const stats = await safe('indexes', () => this.q(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [db],
    ), []);

    const trg = await safe('triggers', () => this.q(
      `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
      [db],
    ), []);

    const routines = await safe('routines', () => this.q(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, IS_DETERMINISTIC, DATA_TYPE
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
      [db],
    ), []);

    // Assemble columns
    const columnsByTable = new Map<string, ColumnInfo[]>();
    for (const c of cols) {
      const t = String(c['TABLE_NAME']);
      let list = columnsByTable.get(t);
      if (!list) columnsByTable.set(t, (list = []));
      const colType = String(c['COLUMN_TYPE']);
      const enumMatch = /^enum\((.*)\)$/i.exec(colType);
      const enumValues = enumMatch
        ? enumMatch[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '').replace(/''/g, "'"))
        : undefined;
      list.push({
        name: String(c['COLUMN_NAME']),
        dbType: colType,
        nullable: String(c['IS_NULLABLE']).toUpperCase() === 'YES',
        default: c['COLUMN_DEFAULT'] == null ? null : String(c['COLUMN_DEFAULT']),
        generated: /GENERATED/i.test(String(c['EXTRA'] ?? '')),
        comment: c['COLUMN_COMMENT'] ? String(c['COLUMN_COMMENT']) : null,
        ...(enumValues ? { enumValues } : {}),
      });
    }

    // Opt-in: observe the distinct codes a short non-enum text column holds.
    if (this.config.sampleColumnValues) {
      let budget = MAX_SAMPLED_COLUMNS;
      outer: for (const [table, list] of columnsByTable) {
        // Base tables only - sampling a view runs its query (not read-only, slow).
        if (viewDef.has(table)) continue;
        for (let i = 0; i < list.length; i++) {
          if (budget <= 0) break outer;
          const col = list[i]!;
          if (col.enumValues || !isSampleableMysqlType(col.dbType)) continue;
          budget--;
          try {
            const sampled = await this.sampleColumn(db, table, col.name);
            if (sampled) list[i] = { ...col, sampledValues: sampled };
          } catch {
            // Best-effort: a locked-down, huge, or slow column just gets no samples.
          }
        }
      }
    }

    // PK + FK from KEY_COLUMN_USAGE
    const pkByTable = new Map<string, string[]>();
    const fkByTable = new Map<string, ForeignKeyInfo[]>();
    const fkGroups = new Map<string, { table: string; cols: string[]; refTable: string; refCols: string[] }>();
    for (const k of keyCols) {
      const table = String(k['TABLE_NAME']);
      const con = String(k['CONSTRAINT_NAME']);
      const col = String(k['COLUMN_NAME']);
      if (con === 'PRIMARY') {
        const arr = pkByTable.get(table) ?? [];
        arr.push(col);
        pkByTable.set(table, arr);
      } else if (k['REFERENCED_TABLE_NAME']) {
        const gk = `${table}.${con}`;
        let g = fkGroups.get(gk);
        if (!g) fkGroups.set(gk, (g = { table, cols: [], refTable: String(k['REFERENCED_TABLE_NAME']), refCols: [] }));
        g.cols.push(col);
        g.refCols.push(String(k['REFERENCED_COLUMN_NAME']));
      }
    }
    for (const g of fkGroups.values()) {
      const arr = fkByTable.get(g.table) ?? [];
      arr.push({ columns: g.cols, refTable: g.refTable, refColumns: g.refCols });
      fkByTable.set(g.table, arr);
    }

    // Indexes
    const idxByTable = new Map<string, Map<string, IndexInfo & { cols: string[] }>>();
    for (const s of stats) {
      const table = String(s['TABLE_NAME']);
      const idxName = String(s['INDEX_NAME']);
      let m = idxByTable.get(table);
      if (!m) idxByTable.set(table, (m = new Map()));
      let ix = m.get(idxName);
      if (!ix) m.set(idxName, (ix = { name: idxName, columns: [], cols: [], unique: Number(s['NON_UNIQUE']) === 0, method: String(s['INDEX_TYPE'] ?? '') }));
      ix.cols.push(String(s['COLUMN_NAME']));
    }

    const tables: TableInfo[] = tablesMeta.map((tm) => {
      const name = String(tm['TABLE_NAME']);
      const isView = String(tm['TABLE_TYPE']).toUpperCase() === 'VIEW';
      const idxMap = idxByTable.get(name);
      const indexes: IndexInfo[] = idxMap
        ? [...idxMap.values()].map((i) => ({ name: i.name, columns: i.cols, unique: i.unique, method: i.method }))
        : [];
      return {
        name,
        kind: isView ? 'view' : 'table',
        columns: columnsByTable.get(name) ?? [],
        primaryKey: pkByTable.get(name) ?? [],
        foreignKeys: fkByTable.get(name) ?? [],
        uniques: indexes.filter((i) => i.unique && i.name !== 'PRIMARY').map((i) => i.columns),
        checks: [],
        indexes,
        comment: tm['TABLE_COMMENT'] ? String(tm['TABLE_COMMENT']) : null,
        rowEstimate: tm['TABLE_ROWS'] == null ? null : Number(tm['TABLE_ROWS']),
        definition: isView ? viewDef.get(name) ?? null : null,
        source: 'db',
      };
    });

    const triggers: TriggerInfo[] = trg.map((t) => ({
      name: String(t['TRIGGER_NAME']),
      table: String(t['EVENT_OBJECT_TABLE']),
      timing: normalizeTiming(t['ACTION_TIMING']),
      events: [String(t['EVENT_MANIPULATION'])],
      enabled: true,
      definition: t['ACTION_STATEMENT'] ? String(t['ACTION_STATEMENT']) : null,
    }));

    const routineInfos: RoutineInfo[] = routines.map((r) => ({
      name: String(r['ROUTINE_NAME']),
      kind: String(r['ROUTINE_TYPE']).toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
      args: '',
      returns: r['DTD_IDENTIFIER'] ? String(r['DTD_IDENTIFIER']) : null,
      // MySQL doesn't expose PG-style volatility; treat deterministic funcs as
      // stable (callable), everything else as unknown (listed, not called).
      volatility: String(r['IS_DETERMINISTIC']).toUpperCase() === 'YES' ? 'stable' : 'unknown',
    }));

    return {
      engine: 'mysql',
      schemas: [db],
      tables,
      enums: [],
      sequences: [],
      triggers,
      routines: routineInfos,
      warnings,
      fetchedAt: new Date().toISOString(),
    };
  }

  async execute(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
    const pool = this.ensure();
    const maxRows = opts?.maxRows ?? 1000;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const started = Date.now();

    let conn: MysqlConn;
    try {
      conn = await pool.getConnection();
    } catch (err) {
      throw mapConnectError(err);
    }
    let onAbort: (() => void) | null = null;
    let cancelled = false;
    try {
      await conn.query('START TRANSACTION READ ONLY');
      const maxMs = Math.max(1, Math.floor(timeoutMs));
      // MAX_EXECUTION_TIME optimizer hint (SELECT only) + session var belt.
      await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${maxMs}`).catch(() => {});

// Reliable backend id for KILL QUERY (thread-id wrappers vary).
      let connId: number | undefined;
      try {
        const [idRows] = await conn.query('SELECT CONNECTION_ID() AS id');
        connId = Number((idRows as Record<string, unknown>[])[0]?.['id']);
      } catch {
        /* cancel becomes best-effort if this fails */
      }
      if (opts?.signal && connId) {
        onAbort = () => {
          cancelled = true;
          void pool.query(`KILL QUERY ${connId}`).catch(() => {});
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        if (opts.signal.aborted) onAbort();
      }

      const [rows, fields] = await conn.query(sql);
      // A killed query can RETURN (e.g. MySQL SLEEP yields 1 when
      // interrupted) rather than throw - never surface a cancelled query's
      // results.
      if (cancelled || opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
      await conn.query('COMMIT').catch(() => {});

      const fieldArr = (fields as { name: string; columnType?: number; type?: number }[] | undefined) ?? [];
      const rowArr = (rows as Record<string, unknown>[]) ?? [];
      // Classify from the driver's column type metadata (robust; digit-count
      // sampling misreads short BIGINTs as text).
      const colNames = fieldArr.length > 0 ? fieldArr.map((f) => f.name) : rowArr[0] ? Object.keys(rowArr[0]) : [];
      const finalCols: ResultColumn[] = colNames.map((name, i) => {
        const f = fieldArr[i];
        // Prefer the driver's column-type metadata; only scan rows for a
        // sample value in the rare case the type code is missing/unknown.
        const kind = mysqlKindFromType(f?.columnType ?? f?.type)
        ?? inferMysqlKind(rowArr.find((r) => r[name] != null)?.[name]);
        return { name, kind };
      });
      const truncated = rowArr.length > maxRows;
      const clipped = truncated ? rowArr.slice(0, maxRows) : rowArr;
      const outRows = clipped.map((r) => colNames.map((name) => shapeMysqlValue(r[name])));
      return {
        columns: finalCols,
        rows: outRows,
        rowCount: outRows.length,
        truncated,
        durationMs: Date.now() - started,
        warnings: [],
      };
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      if (cancelled || opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
      throw mapQueryError(err);
    } finally {
      if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      conn.release();
    }
  }

  async explain(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    return this.execute(`EXPLAIN ${sql}`, opts);
  }
}

/** mysql2 protocol column type code -> ColumnKind (the reliable signal). */
function mysqlKindFromType(t: number | undefined): ResultColumn['kind'] | null {
  if (t === undefined) return null;
  switch (t) {
    case 8: // LONGLONG (BIGINT)
      return 'bigint';
    case 0: // DECIMAL
    case 246: // NEWDECIMAL
      return 'decimal';
    case 1: // TINY
    case 2: // SHORT
    case 3: // LONG (INT)
    case 9: // INT24
    case 13: // YEAR
    case 4: // FLOAT
    case 5: // DOUBLE
      return 'number';
    case 7: // TIMESTAMP
    case 12: // DATETIME
      return 'timestamp';
    case 10: // DATE
    case 14: // NEWDATE
      return 'date';
    case 245: // JSON
      return 'json';
    case 249: // TINY_BLOB
    case 250: // MEDIUM_BLOB
    case 251: // LONG_BLOB
    case 252: // BLOB
    case 16: // BIT
      return 'binary';
    case 15: // VARCHAR
    case 253: // VAR_STRING
    case 254: // STRING
    case 247: // ENUM
    case 248: // SET
      return 'text';
    default:
      return null;
  }
}

function inferMysqlKind(sample: unknown): ResultColumn['kind'] {
  if (sample === null || sample === undefined) return 'unknown';
  if (typeof sample === 'bigint') return 'bigint';
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'boolean';
  if (Buffer.isBuffer(sample)) return 'binary';
  if (sample instanceof Date) return 'timestamp';
  if (typeof sample === 'object') return 'json';
  // Strings that look like a big integer or decimal (from bigNumberStrings).
  if (typeof sample === 'string' && /^-?\d{16,}$/.test(sample)) return 'bigint';
  if (typeof sample === 'string' && /^-?\d+\.\d+$/.test(sample)) return 'decimal';
  return 'text';
}

function shapeMysqlValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return { __binary: { bytes: v.length, hexPreview: v.subarray(0, 16).toString('hex') } };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

function mapConnectError(err: unknown): AskSqlError {
  const code = (err as { code?: string })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR' || /access denied/i.test(msg)) {
    return new AskSqlError('DB_AUTH', { detail: msg, cause: err });
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || /connect|getaddrinfo/i.test(msg)) {
    return new AskSqlError('DB_UNREACHABLE', { detail: msg, cause: err });
  }
  return new AskSqlError('DB_UNREACHABLE', { detail: msg, cause: err });
}

function mapQueryError(err: unknown): AskSqlError {
  const code = (err as { code?: string })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'ER_QUERY_TIMEOUT' || /max_execution_time|query execution was interrupted/i.test(msg)) {
    return new AskSqlError('DB_TIMEOUT', { detail: msg, cause: err });
  }
  if (/cannot execute statement in a READ ONLY transaction|read-only/i.test(msg)) {
    return new AskSqlError('GUARD_BLOCKED', {
      userMessage: 'Blocked for safety: the database rejected a write in read-only mode.',
      detail: msg,
      cause: err,
    });
  }
  return new AskSqlError('DB_QUERY_ERROR', { userMessage: `The query failed: ${msg.split('\n')[0]!.slice(0, 200)}`, detail: msg, cause: err });
}

function normalizeTiming(v: unknown): TriggerInfo['timing'] {
  const t = String(v ?? '').toUpperCase();
  return t === 'BEFORE' || t === 'AFTER' || t === 'INSTEAD OF' ? t : 'UNKNOWN';
}
