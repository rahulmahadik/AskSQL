/** Client-supplied connection details opened server-side (a browser extension cannot open a DB socket). OFF unless the operator opts in - dialling arbitrary hosts is an SSRF primitive - and link-local (cloud-metadata) addresses are refused even when on. */
import { AskSqlError, type Connector } from '@asksql/core';
import type { MongoConnector } from '@asksql/core/mongo';

export type DynamicEngine = 'postgres' | 'mysql' | 'oracle' | 'mongodb' | 'sqlite' | 'duckdb';

export interface ConnectionSpec {
  readonly id?: string;
  readonly name: string;
  readonly engine: DynamicEngine;
  readonly host?: string;
  readonly port?: number;
  /** Database name; for sqlite/duckdb this is the file path instead. */
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  /** MongoDB only: a mongodb:// or mongodb+srv:// connection string. */
  readonly uri?: string;
  readonly ssl?: 'disable' | 'trust' | 'verify';
}

export interface DynamicConnectionOptions {
  /** Must be explicitly true; anything else leaves the endpoints returning 404. */
  readonly enabled: boolean;
  /** When set, only these hostnames may be dialled. */
  readonly allowedHosts?: readonly string[];
}

/** Per-engine defaults, so a client form can prefill the same values a DB tool would. */
export const ENGINE_DEFAULTS: Readonly<
  Record<DynamicEngine, { port?: number; user?: string; usesFilePath: boolean; usesUri?: boolean }>
> = {
  postgres: { port: 5432, user: 'postgres', usesFilePath: false },
  mysql: { port: 3306, user: 'root', usesFilePath: false },
  oracle: { port: 1521, user: 'system', usesFilePath: false },
  mongodb: { usesFilePath: false, usesUri: true },
  sqlite: { usesFilePath: true },
  duckdb: { usesFilePath: true },
};

const ENGINES = Object.keys(ENGINE_DEFAULTS) as DynamicEngine[];

function bad(userMessage: string, detail: string): AskSqlError {
  return new AskSqlError('INVALID_INPUT', { detail, userMessage });
}

/** 169.254.0.0/16 reaches cloud instance metadata; refuse it however it is spelled. */
function isLinkLocal(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'metadata.google.internal') return true;
  const parts = lower.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return nums[0] === 169 && nums[1] === 254;
}

/** Host names inside a mongodb:// or mongodb+srv:// URI (may list several, comma-separated). */
export function mongoUriHosts(uri: string): string[] {
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const hostPart = afterScheme.split(/[/?]/, 1)[0] ?? '';
  return hostPart
    .split(',')
    .map((h) => h.split(':')[0]?.trim().toLowerCase() ?? '')
    .filter((h) => h.length > 0);
}

export function assertSpecAllowed(spec: ConnectionSpec, options: DynamicConnectionOptions): void {
  if (!ENGINES.includes(spec.engine)) {
    throw bad(`Unsupported engine.`, `unknown engine: ${String(spec.engine)}`);
  }
  if (!spec.name?.trim()) throw bad('The connection needs a name.', 'missing name');

  const defaults = ENGINE_DEFAULTS[spec.engine];
  if (defaults.usesFilePath) {
    if (!spec.database?.trim()) throw bad('Enter the database file path.', 'missing file path');
    return;
  }

  if (defaults.usesUri) {
    const uri = spec.uri?.trim();
    if (!uri) throw bad('Enter the MongoDB connection string.', 'missing uri');
    if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
      throw bad('The MongoDB connection string must start with mongodb:// or mongodb+srv://.', 'bad mongo scheme');
    }
    if (/\/\/[^/@]*:[^/@]*@/.test(uri)) {
      throw bad('Put the user and password in their own fields, not in the connection string.', 'embedded credentials');
    }
    if (!spec.database?.trim()) throw bad('Enter the database name.', 'missing database');
    // The URI names hosts too - they get the same SSRF floor as spec.host, or
    // mongodb://169.254.169.254/ would sail past both checks below.
    for (const uriHost of mongoUriHosts(uri)) {
      if (isLinkLocal(uriHost)) throw bad('That host address is not allowed.', 'link-local mongo host');
      if (options.allowedHosts && !options.allowedHosts.includes(uriHost)) {
        throw bad(`This server is not allowed to connect to ${uriHost}.`, 'mongo host not in allowlist');
      }
    }
    return;
  }

  const host = spec.host?.trim();
  if (!host) throw bad('Enter the database host.', 'missing host');
  if (/[/?#&@\s]/.test(host)) throw bad('The host contains characters that are not allowed.', 'bad host');
  if (isLinkLocal(host)) throw bad('That host address is not allowed.', 'link-local host');
  if (options.allowedHosts && !options.allowedHosts.includes(host)) {
    throw bad(`This server is not allowed to connect to ${host}.`, 'host not in allowlist');
  }
  if (spec.port !== undefined && (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535)) {
    throw bad('The port must be between 1 and 65535.', `bad port: ${String(spec.port)}`);
  }
  if (!spec.database?.trim()) throw bad('Enter the database name.', 'missing database');
}

// Driver packages are optional peers; each is imported only when its engine is requested.
/** Mongo is not a SQL `Connector`, so it is built separately and kept on its own path. */
export async function createMongoConnector(spec: ConnectionSpec, id: string): Promise<MongoConnector> {
  const { MongodbConnector } = await import('@asksql/mongodb');
  return new MongodbConnector({
    id,
    name: spec.name.trim(),
    connectionString: spec.uri!,
    database: spec.database!,
    ...(spec.user ? { user: spec.user } : {}),
    ...(spec.password ? { password: spec.password } : {}),
  }) as unknown as MongoConnector;
}

export async function createConnector(spec: ConnectionSpec, id: string): Promise<Connector> {
  const common = { id, name: spec.name.trim() };
  switch (spec.engine) {
    case 'mongodb':
      throw new AskSqlError('CONFIG_ERROR', { detail: 'mongodb uses createMongoConnector', userMessage: 'Internal routing error.' });
    case 'postgres': {
      const { PostgresConnector } = await import('@asksql/postgres');
      return new PostgresConnector({
        ...common,
        host: spec.host,
        port: spec.port ?? ENGINE_DEFAULTS.postgres.port,
        database: spec.database!,
        user: spec.user,
        password: spec.password,
        ...(spec.ssl && spec.ssl !== 'disable' ? { ssl: { rejectUnauthorized: spec.ssl === 'verify' } } : {}),
      });
    }
    case 'mysql': {
      const { MysqlConnector } = await import('@asksql/mysql');
      return new MysqlConnector({
        ...common,
        host: spec.host,
        port: spec.port ?? ENGINE_DEFAULTS.mysql.port,
        database: spec.database!,
        user: spec.user,
        password: spec.password,
        ...(spec.ssl && spec.ssl !== 'disable' ? { ssl: { rejectUnauthorized: spec.ssl === 'verify' } } : {}),
      });
    }
    case 'oracle': {
      const { OracleConnector } = await import('@asksql/oracle');
      return new OracleConnector({
        ...common,
        host: spec.host,
        port: spec.port ?? ENGINE_DEFAULTS.oracle.port,
        database: spec.database!,
        user: spec.user,
        password: spec.password,
      });
    }
    case 'sqlite': {
      const { SqliteConnector } = await import('@asksql/sqlite');
      return new SqliteConnector({ ...common, file: spec.database! });
    }
    case 'duckdb': {
      const { DuckDbConnector } = await import('@asksql/duckdb');
      return new DuckDbConnector({ ...common, path: spec.database! });
    }
  }
}
