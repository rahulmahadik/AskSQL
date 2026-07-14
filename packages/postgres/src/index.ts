/**
 * @asksql/postgres - PostgreSQL connector.
 *
 * - Read-only session enforcement: every query runs inside a
 * `READ ONLY` transaction with a `SET LOCAL statement_timeout`, so even
 * if the guard were bypassed the database itself rejects writes.
 * - Cancellation: the backend PID is captured per query and a
 * fresh connection issues `pg_cancel_backend` on abort.
 * - Row cap enforced at the driver via a hard slice, independent of the
 * guard's LIMIT injection (defense in depth).
 *
 * `pg` is a peer dependency - imported lazily so installing this package
 * never pulls a driver a user doesn't want.
 */

import {
  AskSqlError,
  POSTGRES_DIALECT,
  type CapabilityFlags,
  type Connector,
  type ExecuteOptions,
  type ResultSet,
  type SchemaCatalog,
} from '@asksql/core';
import { introspectPostgres } from './introspect.js';
import { columnsFromFields, shapeValue, type PgField } from './rows.js';

export interface PostgresConnectorConfig {
  readonly id: string;
  readonly name: string;
  /** Standard libpq connection string, e.g. postgres://user:pass@host/db. */
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
  readonly ssl?: boolean | Record<string, unknown>;
  readonly max?: number;
  /** Include pg_catalog / information_schema in the catalog. Default false. */
  readonly includeSystemSchemas?: boolean;
}

interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[][] | Record<string, unknown>[]; fields: PgField[]; rowCount: number | null }>;
  release(): void;
  processID?: number;
}

const CAPABILITIES: CapabilityFlags = {
  supportsCancel: true,
  supportsExplain: true,
  supportsSchemas: true,
  readOnlySession: true,
  supportsMatViews: true,
  supportsTriggers: true,
  supportsRoutines: true,
};

export class PostgresConnector implements Connector {
  readonly engine = 'postgres' as const;
  readonly dialect = POSTGRES_DIALECT;
  readonly capabilities = CAPABILITIES;
  readonly id: string;
  readonly name: string;

  private pool: PgPool | null = null;
  private typeNameCache: Map<number, string> | null = null;

  constructor(private readonly config: PostgresConnectorConfig) {
    this.id = config.id;
    this.name = config.name;
  }

  private async pg(): Promise<{ Pool: new (o: object) => PgPool }> {
    try {
      const mod = (await import('pg')) as unknown as {
        default?: { Pool: new (o: object) => PgPool; types?: PgTypes };
        Pool?: new (o: object) => PgPool;
        types?: PgTypes;
      };
      const Pool = mod.Pool ?? mod.default?.Pool;
      if (!Pool) throw new Error('pg.Pool not found');
      configureTypeParsers(mod.types ?? mod.default?.types);
      return { Pool };
    } catch (err) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `cannot import pg: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: 'The PostgreSQL driver is not installed. Run: npm install pg',
        cause: err,
      });
    }
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    const { Pool } = await this.pg();
    const opts: Record<string, unknown> = this.config.connectionString
      ? { connectionString: this.config.connectionString }
      : {
          host: this.config.host,
          port: this.config.port,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
        };
    if (this.config.ssl !== undefined) opts['ssl'] = this.config.ssl;
    opts['max'] = this.config.max ?? 5;
    opts['application_name'] = 'asksql';
    this.pool = new Pool(opts);
    // Fail fast + friendly on auth / unreachable.
    try {
      const c = await this.pool.connect();
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
  }

  private async ensure(): Promise<PgPool> {
    if (!this.pool) await this.connect();
    if (!this.pool) throw new AskSqlError('DB_UNREACHABLE', { detail: 'pool not initialized' });
    return this.pool;
  }

  async introspect(): Promise<SchemaCatalog> {
    const pool = await this.ensure();
    try {
      return await introspectPostgres(pool, { includeSystem: this.config.includeSystemSchemas ?? false });
    } catch (err) {
      throw AskSqlError.from(err, 'DB_QUERY_ERROR');
    }
  }

  private async typeName(pool: PgPool, oid: number): Promise<string> {
    if (!this.typeNameCache) {
      this.typeNameCache = new Map();
      try {
        const r = await pool.query(`SELECT oid, typname FROM pg_type`);
        for (const row of r.rows) this.typeNameCache.set(Number(row['oid']), String(row['typname']));
      } catch {
        // best-effort; unknown types fall back to 'unknown'
      }
    }
    return this.typeNameCache.get(oid) ?? 'unknown';
  }

  async execute(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    const pool = await this.ensure();
    const maxRows = opts?.maxRows ?? 1000;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const started = Date.now();

    if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');

    let client: PgClient;
    try {
      client = await pool.connect();
    } catch (err) {
      throw mapConnectError(err);
    }
    const pid = client.processID;
    let onAbort: (() => void) | null = null;
    let cancelled = false;

    try {
      // Cancel via a side connection.
      if (opts?.signal && pid) {
        onAbort = () => {
          cancelled = true;
          void pool.query(`SELECT pg_cancel_backend($1)`, [pid]).catch(() => {});
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Warm the OID->typename cache once so column typing is accurate.
      if (!this.typeNameCache) await this.typeName(pool, 0);

      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);

// rowMode 'array' preserves positional duplicate column names.
      const res = await client.query({ text: sql, rowMode: 'array' } as unknown as string);
      await client.query('COMMIT').catch(() => {});

      const fields = res.fields ?? [];
      const columns = columnsFromFields(fields, (oid) => this.typeNameCacheGet(oid));

      const rawRows = res.rows as unknown[][];
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
      await client.query('ROLLBACK').catch(() => {});
      if (cancelled || opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
      throw mapQueryError(err);
    } finally {
      if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      client.release();
    }
  }

  private typeNameCacheGet(oid: number): string {
    return this.typeNameCache?.get(oid) ?? 'unknown';
  }

  async explain(sql: string, opts?: ExecuteOptions): Promise<ResultSet> {
    return this.execute(`EXPLAIN ${sql}`, opts);
  }
}

interface PgTypes {
  setTypeParser(oid: number, parser: (value: string) => unknown): void;
}

let parsersConfigured = false;

/**
 * Return date / time-without-zone types as their raw string so a DATE never
 * shifts a day through a JS `Date` + `toISOString` round-trip.
 * `timestamptz` is left as the driver default (an absolute instant -> ISO-Z,
 * which is unambiguous). Idempotent; the parser table is process-global.
 */
function configureTypeParsers(types: PgTypes | undefined): void {
  if (parsersConfigured || !types) return;
  const identity = (v: string): string => v;
  types.setTypeParser(1082, identity); // date
  types.setTypeParser(1114, identity); // timestamp (without time zone)
  types.setTypeParser(1083, identity); // time
  types.setTypeParser(1266, identity); // timetz
  parsersConfigured = true;
}

function mapConnectError(err: unknown): AskSqlError {
  const code = (err as { code?: string })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === '28P01' || code === '28000' || /password authentication failed|role.* does not exist/i.test(msg)) {
    return new AskSqlError('DB_AUTH', { detail: msg, cause: err });
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || /connect|getaddrinfo|timeout/i.test(msg)) {
    return new AskSqlError('DB_UNREACHABLE', { detail: msg, cause: err });
  }
  return new AskSqlError('DB_UNREACHABLE', { detail: msg, cause: err });
}

function mapQueryError(err: unknown): AskSqlError {
  const code = (err as { code?: string })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === '57014' || /statement timeout|canceling statement due to statement timeout/i.test(msg)) {
    return new AskSqlError('DB_TIMEOUT', { detail: msg, cause: err });
  }
if (code === '25006' || /read-only transaction|cannot execute.* in a read-only/i.test(msg)) {
    return new AskSqlError('GUARD_BLOCKED', {
      userMessage: 'Blocked for safety: the database rejected a write in read-only mode.',
      detail: msg,
      cause: err,
    });
  }
  // Sanitize: never surface internal positions/hints verbatim beyond the message.
  return new AskSqlError('DB_QUERY_ERROR', {
    userMessage: `The query failed: ${firstLine(msg)}`,
    detail: msg,
    cause: err,
  });
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.slice(0, 200);
}

