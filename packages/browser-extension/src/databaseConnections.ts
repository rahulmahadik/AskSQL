/** A browser extension cannot open a database socket, so form details are POSTed to the AskSQL server, which opens the connection and returns an id - the extension stores the id, never the password. Requires the server to enable dynamic connections (404 otherwise). */
import { assertBaseUrl } from '@asksql/core/providers';

export type DatabaseEngine = 'postgres' | 'mysql' | 'oracle' | 'mongodb' | 'sqlite' | 'duckdb';

export interface EngineProfile {
  readonly label: string;
  readonly port?: number;
  readonly user?: string;
  /** sqlite/duckdb take a file path on the server instead of host/port/user. */
  readonly usesFilePath: boolean;
  /** mongodb is addressed by connection string rather than host/port. */
  readonly usesUri?: boolean;
  readonly databaseLabel: string;
  readonly supportsSsl: boolean;
}

// Mirrors ENGINE_DEFAULTS in @asksql/server and the JetBrains connection dialog.
export const ENGINE_PROFILES: Readonly<Record<DatabaseEngine, EngineProfile>> = {
  postgres: {
    label: 'PostgreSQL',
    port: 5432,
    user: 'postgres',
    usesFilePath: false,
    databaseLabel: 'Database',
    supportsSsl: true,
  },
  mysql: {
    label: 'MySQL',
    port: 3306,
    user: 'root',
    usesFilePath: false,
    databaseLabel: 'Database',
    supportsSsl: true,
  },
  oracle: {
    label: 'Oracle',
    port: 1521,
    user: 'system',
    usesFilePath: false,
    databaseLabel: 'Service name',
    supportsSsl: false,
  },
  mongodb: { label: 'MongoDB', usesFilePath: false, usesUri: true, databaseLabel: 'Database', supportsSsl: false },
  sqlite: {
    label: 'SQLite',
    usesFilePath: true,
    databaseLabel: 'Database file path (on the server)',
    supportsSsl: false,
  },
  duckdb: {
    label: 'DuckDB',
    usesFilePath: true,
    databaseLabel: 'Database file path (on the server)',
    supportsSsl: false,
  },
};

export const DATABASE_ENGINES = Object.keys(ENGINE_PROFILES) as DatabaseEngine[];

export interface DatabaseForm {
  readonly engine: DatabaseEngine;
  readonly uri: string;
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: 'disable' | 'trust' | 'verify';
}

export function defaultsFor(engine: DatabaseEngine): DatabaseForm {
  const profile = ENGINE_PROFILES[engine];
  return {
    engine,
    uri: profile.usesUri ? 'mongodb://localhost:27017' : '',
    host: profile.usesFilePath ? '' : 'localhost',
    port: profile.port ? String(profile.port) : '',
    database: '',
    user: profile.user ?? '',
    password: '',
    ssl: 'trust',
  };
}

export interface CreatedDatabaseConnection {
  readonly remoteConnectionId: string;
  readonly engine: string;
  readonly database?: string;
}

/**
 * Sends the details to the server and returns the connection it opened; the
 * server connects eagerly, so a wrong password or host fails here.
 */
export async function createRemoteDatabaseConnection(
  serverBaseUrl: string,
  authHeader: string | undefined,
  name: string,
  form: DatabaseForm,
): Promise<CreatedDatabaseConnection> {
  // Credentials cross this link, so plaintext http to anything but localhost is refused.
  assertBaseUrl(serverBaseUrl, true);

  const profile = ENGINE_PROFILES[form.engine];
  const body = {
    name,
    engine: form.engine,
    database: form.database.trim(),
    // Mongo is addressed by connection string but still takes credentials as their own fields.
    ...(profile.usesUri ? { uri: form.uri.trim() } : {}),
    ...(profile.usesFilePath
      ? {}
      : {
          user: form.user.trim() || undefined,
          password: form.password || undefined,
          ...(profile.usesUri
            ? {}
            : {
                host: form.host.trim(),
                port: form.port.trim() ? Number(form.port) : undefined,
                ...(profile.supportsSsl ? { ssl: form.ssl } : {}),
              }),
        }),
  };

  let res: Response;
  try {
    res = await fetch(`${serverBaseUrl.replace(/\/$/, '')}/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: authHeader } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    // "Failed to fetch" is what the browser gives when nothing is listening; say what to do.
    throw new Error(
      `No AskSQL server is reachable at ${serverBaseUrl}. Start one in a terminal and leave it running: ` +
        `npx --package=@asksql/server asksql serve --provider <provider> --model <model-id> ` +
        `(npx ships with Node.js - install it from nodejs.org if the command is not found).`,
    );
  }

  if (res.status === 404) {
    throw new Error(
      'That AskSQL server does not accept database connections. Restart it with dynamic connections enabled, or add the database to its own configuration instead.',
    );
  }
  const payload = (await res.json().catch(() => null)) as {
    connection?: { id: string; engine: string; database?: string };
    error?: { userMessage?: string };
  } | null;
  if (!res.ok || !payload?.connection) {
    throw new Error(payload?.error?.userMessage ?? `The server rejected the connection (${res.status}).`);
  }
  return {
    remoteConnectionId: payload.connection.id,
    engine: payload.connection.engine,
    database: payload.connection.database,
  };
}

/** Opens the connection on the server and immediately drops it again - proves the details work before anything is saved. */
export async function testRemoteDatabaseConnection(
  serverBaseUrl: string,
  authHeader: string | undefined,
  form: DatabaseForm,
): Promise<string> {
  const created = await createRemoteDatabaseConnection(serverBaseUrl, authHeader, 'Connection test', form);
  // The server answers 415 to any non-GET without this, so without it the cleanup never happened
  // and every test left a live connection behind.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader) headers['Authorization'] = authHeader;
  await fetch(`${serverBaseUrl.replace(/\/$/, '')}/connections/${encodeURIComponent(created.remoteConnectionId)}`, {
    method: 'DELETE',
    headers,
  }).catch(() => {
    // The database answered, which is what was tested; a failed cleanup only leaks an idle connection.
  });
  return `Connected to ${created.engine}${created.database ? ` · ${created.database}` : ''}.`;
}
