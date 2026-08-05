/**
 * @asksql/mysql - MySQL connector: information_schema introspection, each query in a
 * `START TRANSACTION READ ONLY` under a `MAX_EXECUTION_TIME` statement hint, and cancellation
 * via `KILL QUERY <connectionId>` from a side connection. `mysql2` is a lazily imported peer.
 */

import {
  AskSqlError,
  MYSQL_DIALECT,
  type CapabilityFlags,
  type Connector,
  type ExecuteOptions,
  type ResultSet,
  type SchemaCatalog,
} from '@asksql/core';
import { introspectMysql } from './introspect.js';
import { columnsFromFields, shapeMysqlValue, type MysqlField } from './rows.js';

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
  /** Opt-in: sample distinct values from short non-enum text columns, so the model sees the real codes they hold. */
  readonly sampleColumnValues?: boolean;
}

interface MysqlPool {
  getConnection(): Promise<MysqlConn>;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}
interface MysqlConn {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  query(options: { sql: string; rowsAsArray?: boolean }): Promise<[unknown, unknown]>;
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

export class MysqlConnector implements Connector {
  readonly engine = 'mysql' as const;
  readonly dialect = MYSQL_DIALECT;
  readonly capabilities = CAPABILITIES;
  readonly id: string;
  readonly name: string;
  readonly database?: string;
  private pool: MysqlPool | null = null;
  private resolvedDb: string | undefined;

  constructor(private readonly config: MysqlConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
    this.database = config.database || undefined;
  }

  /**
   * The database to introspect: config.database, or - in DSN mode, where the connection
   * string picks it - whatever the server reports as current. Cached after the first look.
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
        userMessage:
          'This connection string does not select a database. Add the database name to the URL, for example .../your_database.',
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

  async introspect(): Promise<SchemaCatalog> {
    const db = await this.databaseName();
    return introspectMysql(
      { query: (sql, params) => this.q(sql, params) },
      { database: db, sampleColumnValues: this.config.sampleColumnValues ?? false },
    );
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
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await conn.query('START TRANSACTION READ ONLY');
      const maxMs = Math.max(1, Math.floor(timeoutMs));
      // Statement-scoped hint: SET SESSION would outlive release() and cap the next query
      // this pooled connection serves. Anything the hint cannot reach keeps the client deadline.
      const deadlined = withMaxExecutionTime(sql, maxMs);

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

      // Client-side deadline for a server that ignored the hint: on expiry, KILL the backend and
      // reject the race. The query keeps its own catch so its later rejection is not unhandled.
      const runQuery = (async (): Promise<[unknown, unknown]> => {
        try {
          return await conn.query({ sql: deadlined, rowsAsArray: true });
        } catch (err) {
          if (timedOut) return [[], []];
          throw err;
        }
      })();
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (connId) void pool.query(`KILL QUERY ${connId}`).catch(() => {});
          reject(new AskSqlError('DB_TIMEOUT', { detail: `query exceeded ${maxMs}ms` }));
        }, maxMs);
      });
      const [rows, fields] = await Promise.race([runQuery, deadline]);
      // A killed query can return rather than throw (MySQL SLEEP yields 1 when interrupted).
      if (cancelled || opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
      await conn.query('COMMIT').catch(() => {});

      const fieldArr = (fields as MysqlField[] | undefined) ?? [];
      const rowArr = (rows as unknown[][]) ?? [];
      const finalCols = columnsFromFields(fieldArr, rowArr);
      const truncated = rowArr.length > maxRows;
      const clipped = truncated ? rowArr.slice(0, maxRows) : rowArr;
      const outRows = clipped.map((r) => finalCols.map((_, i) => shapeMysqlValue(r[i])));
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
      if (timedOut)
        throw new AskSqlError('DB_TIMEOUT', {
          userMessage: 'The query took too long and was stopped.',
          detail: `query exceeded ${Math.max(1, Math.floor(timeoutMs))}ms`,
        });
      throw mapQueryError(err);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      conn.release();
    }
  }

  async explain(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    return this.execute(`EXPLAIN ${sql}`, opts);
  }
}

/**
 * Attach MySQL's `MAX_EXECUTION_TIME(ms)` optimizer hint to a leading SELECT. The hint must sit
 * immediately after that keyword, so any other statement shape is returned untouched.
 */
function withMaxExecutionTime(sql: string, maxMs: number): string {
  const lead = /^(?:\s|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)*SELECT\b/i.exec(sql);
  if (!lead) return sql;
  const end = lead[0].length;
  return `${sql.slice(0, end)} /*+ MAX_EXECUTION_TIME(${maxMs}) */${sql.slice(end)}`;
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
  return new AskSqlError('DB_QUERY_ERROR', {
    userMessage: `The query failed: ${msg.split('\n')[0]!.slice(0, 200)}`,
    detail: msg,
    cause: err,
  });
}
