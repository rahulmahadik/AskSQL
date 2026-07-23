/**
 * @asksql/oracle - Oracle Database connector.
 *
 * - Read-only session enforcement: every query runs inside a
 *   `SET TRANSACTION READ ONLY` transaction (autoCommit off), so even if the
 *   guard were bypassed the database itself rejects writes for that statement.
 * - Row cap enforced at the driver (`maxRows`) AND with a hard slice
 *   afterwards (defense in depth), independent of the guard's row limiting.
 * - Numeric fidelity: NUMBER is fetched as a string so BIGINT/DECIMAL never
 *   round-trip through a JS number; CLOB as string, BLOB as Buffer.
 *
 * `oracledb` is a peer dependency, imported lazily so installing this package
 * never pulls a driver a user doesn't want. It is used in pure-JS Thin mode -
 * `initOracleClient` is never called, so no Oracle Instant Client is required.
 */

import {
  AskSqlError,
  ORACLE_DIALECT,
  type CapabilityFlags,
  type Connector,
  type ExecuteOptions,
  type ResultSet,
  type SchemaCatalog,
} from '@asksql/core';
import { introspectOracle } from './introspect.js';
import { columnsFromMeta, shapeValue, type OracleField } from './rows.js';

export interface OracleConnectorConfig {
  readonly id: string;
  readonly name: string;
  /**
   * Easy Connect / TNS connect string, e.g. `host:1521/service` or a full
   * descriptor. Used verbatim when the discrete host/port/database fields are
   * not supplied.
   */
  readonly connectString?: string;
  readonly host?: string;
  /** Listener port. Defaults to 1521 when discrete fields are used. */
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  /** Service name, used as the connect-string service when host is given. */
  readonly database?: string;
  /**
   * Opt-in placeholder for parity with other connectors. Value sampling is not
   * implemented for Oracle in this version; setting it has no effect.
   */
  readonly sampleColumnValues?: boolean;
  /** Per-call timeout (ms) for the schema read. Defaults to 60s. */
  readonly introspectTimeoutMs?: number;
}

// Minimal structural views over the parts of the `oracledb` API this connector
// uses. The dynamic import is cast through `unknown` to these, so the package
// typechecks against its own contract rather than the driver's ambient types.
interface OracleModule {
  readonly OUT_FORMAT_ARRAY: number;
  readonly OUT_FORMAT_OBJECT: number;
  readonly CLOB: number;
  readonly BLOB: number;
  readonly NUMBER: number;
  readonly STRING: number;
  readonly BUFFER: number;
  createPool(config: Record<string, unknown>): Promise<OraclePool>;
}

/** Column metadata passed to a per-execute `fetchTypeHandler`. */
interface OracleFetchMeta {
  readonly dbTypeName?: string;
}
interface OraclePool {
  getConnection(): Promise<OracleConnection>;
  close(drainTime?: number): Promise<void>;
}
interface OracleExecuteResult {
  rows?: unknown[];
  metaData?: OracleField[];
}
interface OracleConnection {
  callTimeout?: number;
  execute(
    sql: string,
    binds?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<OracleExecuteResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  break?(): Promise<void>;
  close(): Promise<void>;
}

const CAPABILITIES: CapabilityFlags = {
  supportsCancel: false,
  supportsExplain: false,
  supportsSchemas: true,
  readOnlySession: true,
  supportsMatViews: false,
  supportsTriggers: true,
  supportsRoutines: true,
};

export class OracleConnector implements Connector {
  readonly engine = 'oracle' as const;
  readonly dialect = ORACLE_DIALECT;
  readonly capabilities = CAPABILITIES;
  readonly id: string;
  readonly name: string;
  readonly database?: string;

  private pool: OraclePool | null = null;
  private driver: OracleModule | null = null;

  constructor(private readonly config: OracleConnectorConfig) {
    if (!config.connectString && !config.host) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `oracle connector "${config.id ?? '(no id)'}" has neither connectString nor host`,
        userMessage: 'This Oracle connection is missing its host or connect string.',
      });
    }
    this.id = config.id;
    this.name = config.name;
    this.database = config.database || undefined;
  }

  private buildConnectString(): string {
    if (this.config.host) {
      const port = this.config.port ?? 1521;
      const service = this.config.database ?? '';
      return service ? `${this.config.host}:${port}/${service}` : `${this.config.host}:${port}`;
    }
    return this.config.connectString!;
  }

  private async oracle(): Promise<OracleModule> {
    if (this.driver) return this.driver;
    try {
      const mod = (await import('oracledb')) as unknown as { default?: OracleModule } & Partial<OracleModule>;
      const oracledb = (mod.default ?? mod) as OracleModule;
      if (!oracledb || typeof oracledb.createPool !== 'function') throw new Error('oracledb.createPool not found');
      // Thin mode (v6 default); never initOracleClient. Type coercion is per-execute via
      // fetchTypeHandler, not the process-global fetchAs*, so a host app's oracledb is untouched.
      this.driver = oracledb;
      return oracledb;
    } catch (err) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `cannot import oracledb: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: 'The Oracle driver is not installed. Run: npm install oracledb',
        cause: err,
      });
    }
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    const oracledb = await this.oracle();
    try {
      this.pool = await oracledb.createPool({
        connectString: this.buildConnectString(),
        user: this.config.user,
        password: this.config.password,
        poolMin: 0,
        poolMax: 5,
      });
    } catch (err) {
      throw mapConnectError(err);
    }
    // Fail fast + friendly on auth / unreachable.
    try {
      const c = await this.pool.getConnection();
      await c.close().catch(() => {});
    } catch (err) {
      await this.pool.close(0).catch(() => {});
      this.pool = null;
      throw mapConnectError(err);
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close(0).catch(() => {});
      this.pool = null;
    }
  }

  private async ensure(): Promise<OraclePool> {
    if (!this.pool) await this.connect();
    if (!this.pool) throw new AskSqlError('DB_UNREACHABLE', { detail: 'pool not initialized' });
    return this.pool;
  }

  async introspect(): Promise<SchemaCatalog> {
    const pool = await this.ensure();
    const oracledb = await this.oracle();
    let conn: OracleConnection;
    try {
      conn = await pool.getConnection();
    } catch (err) {
      throw mapConnectError(err);
    }
    // Bound the catalog read like execute() bounds a query, so a stalled instance times out instead of hanging.
    conn.callTimeout = this.config.introspectTimeoutMs ?? 60_000;
    try {
      return await introspectOracle(conn, oracledb.OUT_FORMAT_OBJECT, {
        sampleColumnValues: this.config.sampleColumnValues ?? false,
      });
    } catch (err) {
      throw AskSqlError.from(err, 'DB_QUERY_ERROR');
    } finally {
      await conn.close().catch(() => {});
    }
  }

  async execute(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    const pool = await this.ensure();
    const oracledb = await this.oracle();
    const maxRows = opts?.maxRows ?? 1000;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const started = Date.now();

    if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');

    let conn: OracleConnection;
    try {
      conn = await pool.getConnection();
    } catch (err) {
      throw mapConnectError(err);
    }
    conn.callTimeout = Math.max(1, Math.floor(timeoutMs));

    let onAbort: (() => void) | null = null;
    let cancelled = false;
    try {
      if (opts?.signal) {
        onAbort = () => {
          cancelled = true;
          void conn.break?.().catch(() => {});
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Per-query read-only enforcement: Oracle's read-only transaction covers
      // only itself, so open one, run the SELECT, then commit (autoCommit off).
      await conn.execute('SET TRANSACTION READ ONLY', {}, { autoCommit: false });
      // Fetch one extra row past the cap so truncation is detectable; the driver
      // maxRows is the primary bound and the slice below is the backstop.
      const res = await conn.execute(
        sql,
        {},
        {
          outFormat: oracledb.OUT_FORMAT_ARRAY,
          maxRows: maxRows + 1,
          autoCommit: false,
          // Per-execute fetch coercion (numeric fidelity), scoped to this call so
          // the process-global oracledb defaults stay untouched for the host app.
          fetchTypeHandler: (meta: OracleFetchMeta) => {
            switch (meta?.dbTypeName) {
              case 'NUMBER':
              case 'CLOB':
                return { type: oracledb.STRING };
              case 'BLOB':
                return { type: oracledb.BUFFER };
              default:
                return undefined;
            }
          },
        },
      );
      await conn.commit().catch(() => {});

      const columns = columnsFromMeta(res.metaData ?? []);
      const rawRows = (res.rows ?? []) as unknown[][];
      const truncated = rawRows.length > maxRows;
      const clipped = truncated ? rawRows.slice(0, maxRows) : rawRows;
      const rows = clipped.map((row) => row.map((v, i) => shapeValue(v, columns[i]?.kind ?? 'unknown')));

      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - started,
        warnings: [],
      };
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (cancelled || opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
      throw mapQueryError(err);
    } finally {
      if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      await conn.close().catch(() => {});
    }
  }
}

function oraNum(err: unknown): number | undefined {
  const n = (err as { errorNum?: number })?.errorNum;
  return typeof n === 'number' ? n : undefined;
}

function mapConnectError(err: unknown): AskSqlError {
  const num = oraNum(err);
  const msg = err instanceof Error ? err.message : String(err);
  // ORA-01017 invalid credentials; ORA-01005 null password; ORA-28000 locked.
  if (
    num === 1017 ||
    num === 1005 ||
    num === 28000 ||
    /ORA-01017|invalid username|logon denied|invalid credential/i.test(msg)
  ) {
    return new AskSqlError('DB_AUTH', { detail: msg, cause: err });
  }
  return new AskSqlError('DB_UNREACHABLE', { detail: msg, cause: err });
}

function mapQueryError(err: unknown): AskSqlError {
  const num = oraNum(err);
  const msg = err instanceof Error ? err.message : String(err);

  // Call timeout / cancelled-by-timeout (ORA-01013 also fires on callTimeout).
  if (num === 3136 || num === 1013 || /DPI-1067|call timeout|NJS-024|timeout/i.test(msg)) {
    return new AskSqlError('DB_TIMEOUT', { detail: msg, cause: err });
  }
  // Write rejected by the read-only transaction.
  // ORA-01456 (may not perform INSERT/DELETE/UPDATE inside READ ONLY),
  // ORA-01552, ORA-16000 (opened for read-only access).
  if (num === 1456 || num === 1552 || num === 16000 || /read[- ]only|may not perform/i.test(msg)) {
    return new AskSqlError('GUARD_BLOCKED', {
      userMessage: 'Blocked for safety: the database rejected a write in read-only mode.',
      detail: msg,
      cause: err,
    });
  }
  return new AskSqlError('DB_QUERY_ERROR', {
    userMessage: `The query failed: ${firstLine(msg)}`,
    detail: msg,
    cause: err,
  });
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.slice(0, 200);
}
