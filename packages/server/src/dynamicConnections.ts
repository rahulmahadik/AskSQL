/** Client-supplied connection details opened server-side (a browser extension cannot open a DB socket). OFF unless the operator opts in - dialling arbitrary hosts is an SSRF primitive - and link-local (cloud-metadata) addresses are refused even when on. */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';
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
  /** Directories a client-supplied SQLite/DuckDB path may live under. Unset means anywhere. */
  readonly allowedFileRoots?: readonly string[];
  /**
   * Whether a client may name a server-side database file at all. Off unless set: the CLI turns it
   * on for a loopback bind, where the caller is the machine's own user.
   */
  readonly allowFileEngines?: boolean;
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

/**
 * IPv4 as the resolver reads it: dotted-quad, but also a bare decimal (2852039166), hex
 * (0xA9FEA9FE), octal (0251.0376.0251.0376) and short forms (169.16689918). Returns the four
 * octets, or null when the text is not an IPv4 literal at all.
 */
function ipv4Octets(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length > 4 || parts.length === 0) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^[0-9]+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isInteger(value) || value < 0) return null;
    values.push(value);
  }
  // The last part absorbs the remaining octets: 169.16689918 is 169.254.169.254.
  const last = values.pop()!;
  if (last >= 2 ** (8 * (4 - values.length))) return null;
  if (values.some((v) => v > 255)) return null;
  const octets = [...values];
  for (let i = 4 - values.length - 1; i >= 0; i--) octets.push((last >>> (8 * i)) & 0xff);
  return octets as [number, number, number, number];
}

/** Addresses that reach cloud instance metadata or the host itself; refused however they are spelled. */
function isLinkLocal(host: string): boolean {
  let lower = host.trim().toLowerCase();
  if (lower === 'metadata.google.internal') return true;
  // An IPv4-mapped IPv6 literal carries the same address.
  lower = lower.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(.+)$/.exec(lower);
  if (mapped) lower = mapped[1]!;
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return false; // loopback is not metadata
  if (/^fe80:/i.test(lower)) return true; // IPv6 link-local
  const octets = ipv4Octets(lower);
  if (!octets) return false;
  return octets[0] === 169 && octets[1] === 254;
}

/** Host names inside a mongodb:// or mongodb+srv:// URI (may list several, comma-separated). */
export function mongoUriHosts(uri: string): string[] {
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const authority = afterScheme.split(/[/?]/, 1)[0] ?? '';
  // Credentials precede the last '@' and may themselves contain '@'. Left in, they are read as
  // the host, so a filtered address hides behind any username.
  const hostPart = authority.slice(authority.lastIndexOf('@') + 1);
  return hostPart
    .split(',')
    .map((h) => {
      const host = h.trim();
      // An IPv6 literal is bracketed. Splitting on ':' first yields "[", so the address never
      // reaches the link-local filter and a metadata endpoint passes as an unrecognised host.
      if (host.startsWith('[')) {
        const close = host.indexOf(']');
        return (close === -1 ? host.slice(1) : host.slice(1, close)).trim().toLowerCase();
      }
      return host.split(':')[0]?.trim().toLowerCase() ?? '';
    })
    .filter((h) => h.length > 0);
}

/** Real path of `target`, or of its nearest existing ancestor with the rest appended. */
function realpathOr(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    const parent = dirname(target);
    if (parent === target) return target;
    return join(realpathOr(parent), basename(target));
  }
}

/**
 * A client-supplied file path must resolve inside a configured root. Symlinks are resolved first,
 * so a link planted inside the root cannot point out of it.
 */
function assertFileAllowed(file: string, options: DynamicConnectionOptions): void {
  const roots = options.allowedFileRoots;
  // Opening a client-named file is opt-in: unset means no, and so does an empty root list.
  if (options.allowFileEngines !== true && (!roots || roots.length === 0)) {
    throw bad(
      'This server is not configured to open database files.',
      'file engine requires allowFileEngines or allowedFileRoots',
    );
  }
  if (!roots || roots.length === 0) return;
  // A file that does not exist yet is resolved through its parent, so a symlinked root
  // (/tmp -> /private/tmp on macOS) still compares equal.
  const resolved = realpathOr(resolvePath(file));
  const inside = roots.some((root) => {
    const base = realpathOr(resolvePath(root));
    return resolved === base || resolved.startsWith(base.endsWith(sep) ? base : base + sep);
  });
  if (!inside) throw bad('That database file is outside the allowed directory.', 'file path outside allowedFileRoots');
}

export function assertSpecAllowed(spec: ConnectionSpec, options: DynamicConnectionOptions): void {
  if (!ENGINES.includes(spec.engine)) {
    throw bad(`Unsupported engine.`, `unknown engine: ${String(spec.engine)}`);
  }
  if (!spec.name?.trim()) throw bad('The connection needs a name.', 'missing name');

  const defaults = ENGINE_DEFAULTS[spec.engine];
  if (defaults.usesFilePath) {
    const file = spec.database?.trim();
    if (!file) throw bad('Enter the database file path.', 'missing file path');
    assertFileAllowed(file, options);
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
    // Hosts named inside the URI get the same floor as spec.host.
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
      throw new AskSqlError('CONFIG_ERROR', {
        detail: 'mongodb uses createMongoConnector',
        userMessage: 'Internal routing error.',
      });
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
