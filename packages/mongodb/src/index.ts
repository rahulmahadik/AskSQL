/**
 * @asksql/mongodb - MongoDB connector.
 *
 * Implements the non-SQL {@link MongoConnector} contract: results come from a
 * (collection, aggregation-pipeline) pair rather than a SQL string, and the
 * schema is inferred by sampling documents (`introspect`) rather than read from
 * a system catalog.
 *
 * MongoDB has no read-only session, so the connector runs pipelines exactly as
 * given - the core `guardPipeline` re-run on every execute is the safety floor.
 * Numeric fidelity is preserved by disabling Long promotion so 64-bit integers
 * and Decimal128 travel as strings, never as a lossy JS `number`.
 *
 * `mongodb` is a peer dependency, imported lazily so installing this package
 * never pulls a driver a user doesn't want. The pure-JS driver is used - no
 * native addon is required.
 */

import { AskSqlError, type ExecuteOptions, type ResultSet, type SchemaCatalog } from '@asksql/core';
import type { MongoConnector } from '@asksql/core/mongo';
import type { AggregationCursorLike, DbLike, MongoClientLike, MongoModule } from './driver.js';
import { introspectMongo } from './introspect.js';
import { tabulate } from './rows.js';

export interface MongodbConnectorConfig {
  readonly id: string;
  readonly name: string;
  /** Connection string, e.g. `mongodb://host/` or `mongodb+srv://cluster/`. */
  readonly connectionString: string;
  /** Database to introspect and query. Required - names the DB, not a default. */
  readonly database: string;
  readonly user?: string;
  readonly password?: string;
  /** Auth database for separate user/password. Defaults to `admin` (root/Atlas users live there), not the query database. */
  readonly authSource?: string;
  /**
   * Opt-in: attach a small set of distinct example values to low-cardinality
   * fields during introspection, so the model sees the real codes a field holds.
   * This reads actual document values, so it is off unless the caller sets it.
   */
  readonly sampleColumnValues?: boolean;
}

export class MongodbConnector implements MongoConnector {
  readonly engine = 'mongodb' as const;
  readonly id: string;
  readonly name: string;
  readonly database?: string;

  private client: MongoClientLike | null = null;

  constructor(private readonly config: MongodbConnectorConfig) {
    if (!config.connectionString) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `mongodb connector "${config.id ?? '(no id)'}" has no connectionString`,
        userMessage: 'This MongoDB connection is missing its connection string.',
      });
    }
    if (!config.database) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `mongodb connector "${config.id ?? '(no id)'}" has no database`,
        userMessage: 'This MongoDB connection is missing its database name.',
      });
    }
    this.id = config.id;
    this.name = config.name;
    this.database = config.database;
  }

  private async driver(): Promise<MongoModule> {
    try {
      const mod = (await import('mongodb')) as unknown as {
        MongoClient?: MongoModule['MongoClient'];
        EJSON?: MongoModule['EJSON'];
        BSON?: { EJSON?: MongoModule['EJSON'] };
        default?: {
          MongoClient?: MongoModule['MongoClient'];
          EJSON?: MongoModule['EJSON'];
          BSON?: { EJSON?: MongoModule['EJSON'] };
        };
      };
      const MongoClient = mod.MongoClient ?? mod.default?.MongoClient;
      // Newer drivers expose the codec as BSON.EJSON; older ones as a top-level EJSON.
      const EJSON = mod.EJSON ?? mod.BSON?.EJSON ?? mod.default?.EJSON ?? mod.default?.BSON?.EJSON;
      if (!MongoClient || !EJSON) throw new Error('mongodb.MongoClient / EJSON not found');
      return { MongoClient, EJSON };
    } catch (err) {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `cannot import mongodb: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: 'The MongoDB driver is not installed. Run: npm install mongodb',
        cause: err,
      });
    }
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const { MongoClient } = await this.driver();
    const opts: Record<string, unknown> = {
      appName: 'AskSQL',
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      socketTimeoutMS: 30_000,
    };
    if (this.config.user && this.config.password) {
      opts['auth'] = { username: this.config.user, password: this.config.password };
      opts['authSource'] = this.config.authSource || 'admin';
    }
    const client = new MongoClient(this.config.connectionString, opts);
    try {
      await client.connect();
      // Force a real round-trip so an unreachable / unauthorized server fails
      // here rather than lazily at the first query.
      await client.db(this.config.database).command({ ping: 1 });
    } catch (err) {
      await client.close().catch(() => {});
      throw mapConnectError(err, /mongodb\+srv|mongodb\.net/i.test(this.config.connectionString));
    }
    this.client = client;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }

  private async db(): Promise<DbLike> {
    if (!this.client) await this.connect();
    if (!this.client) throw new AskSqlError('DB_UNREACHABLE', { detail: 'client not initialized' });
    return this.client.db(this.config.database);
  }

  async introspect(): Promise<SchemaCatalog> {
    const db = await this.db();
    try {
      return await introspectMongo(db, {
        database: this.config.database,
        sampleColumnValues: this.config.sampleColumnValues ?? false,
      });
    } catch (err) {
      throw AskSqlError.from(err, 'DB_QUERY_ERROR');
    }
  }

  async aggregate(collection: string, pipeline: unknown[], opts?: ExecuteOptions): Promise<ResultSet> {
    const db = await this.db();
    const maxRows = opts?.maxRows ?? 1000;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const started = Date.now();

    if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');

    // Deserialize Extended JSON literals to real BSON types. Strict (relaxed:false) keeps
    // {"$numberLong":..} a BSON Long instead of collapsing a 64-bit filter value to a lossy double.
    const { EJSON } = await this.driver();
    const deserialized = EJSON.deserialize(pipeline, { relaxed: false }) as unknown[];

    // Defense-in-depth DB bound. The guard already appends a trailing $limit <= maxRows,
    // which dominates this probe, so truncation is derived below from filling the cap.
    const limited = [...deserialized, { $limit: maxRows + 1 }];

    const cursor: AggregationCursorLike = db.collection(collection).aggregate(limited, {
      maxTimeMS: timeoutMs,
      promoteValues: true,
      promoteLongs: false,
      promoteBuffers: false,
    });

    let onAbort: (() => void) | null = null;
    if (opts?.signal) {
      onAbort = () => {
        void cursor.close().catch(() => {});
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const docs: Record<string, unknown>[] = [];
    let truncated = false;
    try {
      while (await cursor.hasNext()) {
        if (docs.length >= maxRows) {
          truncated = true;
          break;
        }
        const doc = await cursor.next();
        if (doc === null) break;
        docs.push(doc);
      }
    } catch (err) {
      if (opts?.signal?.aborted) throw new AskSqlError('CANCELLED');
      throw mapQueryError(err);
    } finally {
      if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      await cursor.close().catch(() => {});
    }

    // Mirror the SQL connectors: the guard's injected $limit equals the cap, so
    // filling maxRows is the truncation signal (the overshoot probe never fires).
    if (docs.length >= maxRows) truncated = true;

    const { columns, rows } = tabulate(docs);
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - started,
      warnings: [],
    };
  }
}

function errCode(err: unknown): number | string | undefined {
  return (err as { code?: number | string })?.code;
}

function mapConnectError(err: unknown, isAtlas: boolean): AskSqlError {
  const code = errCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 18 || /authentication failed|auth(?:entication)? error|not authorized|bad auth/i.test(msg)) {
    return new AskSqlError('DB_AUTH', {
      userMessage:
        'MongoDB rejected the credentials. Check the username and password - and remove any placeholder angle brackets (< >) around the password in the connection string.',
      detail: msg,
      cause: err,
    });
  }
  // Any connect failure to an Atlas cluster (srv / *.mongodb.net) - server-selection timeout, DNS, or a
  // TLS handshake alert - is almost always the IP allow-list, so point there.
  return new AskSqlError('DB_UNREACHABLE', {
    userMessage: isAtlas
      ? 'Could not reach the MongoDB Atlas cluster. Add your current IP under Atlas -> Network Access (or 0.0.0.0/0 to test), and confirm the cluster is running.'
      : 'Could not reach the MongoDB server. Check the host/port and that it is running.',
    detail: msg,
    cause: err,
  });
}

function mapQueryError(err: unknown): AskSqlError {
  const code = errCode(err);
  const name = (err as { codeName?: string })?.codeName;
  const msg = err instanceof Error ? err.message : String(err);
  if (
    code === 50 ||
    name === 'MaxTimeMSExpired' ||
    /max(?:imum)? *time *ms *expired|operation exceeded time limit/i.test(msg)
  ) {
    return new AskSqlError('DB_TIMEOUT', { detail: msg, cause: err });
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
