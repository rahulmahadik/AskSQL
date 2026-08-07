import { describe, expect, it } from 'vitest';
import { assertSpecAllowed, ENGINE_DEFAULTS, mongoUriHosts, type ConnectionSpec } from '../src/dynamicConnections.js';

const on = { enabled: true } as const;
const mysql = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({
  name: 'db',
  engine: 'mysql',
  host: 'localhost',
  database: 'app',
  user: 'root',
  ...over,
});

describe('ENGINE_DEFAULTS', () => {
  it('matches the ports a database tool would prefill', () => {
    expect(ENGINE_DEFAULTS.postgres.port).toBe(5432);
    expect(ENGINE_DEFAULTS.mysql.port).toBe(3306);
    expect(ENGINE_DEFAULTS.oracle.port).toBe(1521);
  });

  it('marks the file-backed engines so a form can hide host/port/user', () => {
    expect(ENGINE_DEFAULTS.sqlite.usesFilePath).toBe(true);
    expect(ENGINE_DEFAULTS.duckdb.usesFilePath).toBe(true);
    expect(ENGINE_DEFAULTS.mysql.usesFilePath).toBe(false);
  });
});

describe('assertSpecAllowed', () => {
  it('accepts a complete spec', () => {
    expect(() => assertSpecAllowed(mysql(), on)).not.toThrow();
  });

  it('accepts a file-backed engine when file engines are turned on', () => {
    const withFiles = { ...on, allowFileEngines: true };
    expect(() => assertSpecAllowed({ name: 'f', engine: 'sqlite', database: '/tmp/app.db' }, withFiles)).not.toThrow();
  });

  it('refuses a file-backed engine by default', () => {
    // A client naming a server-side path is a read of that file; it has to be opted into.
    expect(() => assertSpecAllowed({ name: 'f', engine: 'sqlite', database: '/tmp/app.db' }, on)).toThrow();
    expect(() =>
      assertSpecAllowed({ name: 'f', engine: 'duckdb', database: '/etc/passwd' }, { ...on, allowedFileRoots: [] }),
    ).toThrow();
  });

  it('confines a file path to the configured roots', () => {
    const rooted = { ...on, allowedFileRoots: ['/tmp/asksql-data'] };
    expect(() =>
      assertSpecAllowed({ name: 'f', engine: 'sqlite', database: '/tmp/asksql-data/ok.db' }, rooted),
    ).not.toThrow();
    expect(() => assertSpecAllowed({ name: 'f', engine: 'sqlite', database: '/tmp/elsewhere.db' }, rooted)).toThrow();
    expect(() =>
      assertSpecAllowed({ name: 'f', engine: 'sqlite', database: '/tmp/asksql-data/../elsewhere.db' }, rooted),
    ).toThrow();
  });

  it('accepts a MongoDB spec addressed by connection string', () => {
    expect(() =>
      assertSpecAllowed({ name: 'm', engine: 'mongodb', uri: 'mongodb://localhost:27017', database: 'shop' }, on),
    ).not.toThrow();
    expect(() =>
      assertSpecAllowed({ name: 'm', engine: 'mongodb', uri: 'mongodb+srv://c.example.net', database: 'shop' }, on),
    ).not.toThrow();
  });

  it('rejects a MongoDB spec missing its connection string, scheme, or database', () => {
    expect(() => assertSpecAllowed({ name: 'm', engine: 'mongodb', database: 'shop' }, on)).toThrow(/missing uri/i);
    expect(() => assertSpecAllowed({ name: 'm', engine: 'mongodb', uri: 'http://x', database: 'shop' }, on)).toThrow(
      /scheme/i,
    );
    expect(() => assertSpecAllowed({ name: 'm', engine: 'mongodb', uri: 'mongodb://h' }, on)).toThrow(
      /missing database/i,
    );
  });

  it('applies the link-local block to hosts inside the MongoDB connection string', () => {
    expect(() =>
      assertSpecAllowed({ name: 'm', engine: 'mongodb', uri: 'mongodb://169.254.169.254:27017', database: 'shop' }, on),
    ).toThrow(/link-local/i);
    expect(() =>
      assertSpecAllowed(
        { name: 'm', engine: 'mongodb', uri: 'mongodb://METADATA.GOOGLE.INTERNAL/', database: 'shop' },
        on,
      ),
    ).toThrow(/link-local/i);
  });

  it('applies the host allowlist to every host in a multi-host MongoDB URI', () => {
    const opts = { enabled: true, allowedHosts: ['db.internal'] };
    expect(() =>
      assertSpecAllowed({ name: 'm', engine: 'mongodb', uri: 'mongodb://db.internal:27017', database: 'shop' }, opts),
    ).not.toThrow();
    expect(() =>
      assertSpecAllowed(
        { name: 'm', engine: 'mongodb', uri: 'mongodb://db.internal,evil.example:27017/', database: 'shop' },
        opts,
      ),
    ).toThrow(/allowlist/i);
  });

  it('refuses credentials smuggled inside the MongoDB connection string', () => {
    expect(() =>
      assertSpecAllowed({ name: 'm', engine: 'mongodb', uri: 'mongodb://user:pass@h/', database: 'shop' }, on),
    ).toThrow(/embedded credentials/i);
  });

  it('rejects an unknown engine rather than trusting the client', () => {
    expect(() => assertSpecAllowed({ name: 'x', engine: 'redis' as never, database: 'd' }, on)).toThrow(
      /unknown engine/i,
    );
  });

  it.each([
    ['name', mysql({ name: '  ' }), /name/i],
    ['host', mysql({ host: '' }), /host/i],
    ['database', mysql({ database: '' }), /database/i],
  ])('requires %s', (_label, spec, pattern) => {
    expect(() => assertSpecAllowed(spec, on)).toThrow(pattern);
  });

  it('requires a file path for a file-backed engine', () => {
    expect(() => assertSpecAllowed({ name: 'f', engine: 'duckdb' }, on)).toThrow(/file path/i);
  });

  it('refuses link-local hosts, which reach cloud instance metadata', () => {
    expect(() => assertSpecAllowed(mysql({ host: '169.254.169.254' }), on)).toThrow(/link-local/i);
    expect(() => assertSpecAllowed(mysql({ host: 'metadata.google.internal' }), on)).toThrow(/link-local/i);
  });

  it('allows an ordinary private host that merely looks similar', () => {
    expect(() => assertSpecAllowed(mysql({ host: '169.253.1.1' }), on)).not.toThrow();
    expect(() => assertSpecAllowed(mysql({ host: '10.0.0.5' }), on)).not.toThrow();
  });

  it('refuses a host carrying URL punctuation, which could smuggle another target', () => {
    for (const host of ['evil.com/path', 'a@b', 'host name', 'h?x', 'h#f', 'a&b']) {
      expect(() => assertSpecAllowed(mysql({ host }), on)).toThrow(/bad host/i);
    }
  });

  it('enforces an operator host allowlist when one is set', () => {
    const opts = { enabled: true, allowedHosts: ['db.internal'] };
    expect(() => assertSpecAllowed(mysql({ host: 'db.internal' }), opts)).not.toThrow();
    expect(() => assertSpecAllowed(mysql({ host: 'localhost' }), opts)).toThrow(/allowlist/i);
  });

  it('rejects a port outside the valid range', () => {
    for (const port of [0, 65536, 1.5, -1]) {
      expect(() => assertSpecAllowed(mysql({ port }), on)).toThrow(/port/i);
    }
    expect(() => assertSpecAllowed(mysql({ port: 3306 }), on)).not.toThrow();
  });
});

// Credentials in the URI were read as the host, so any username hid the address the filter exists
// to reject: mongodb://user@169.254.169.254 reported "user" and sailed past the link-local check.
describe('mongoUriHosts and userinfo', () => {
  it('reads the host behind credentials', () => {
    expect(mongoUriHosts('mongodb://user:pass@169.254.169.254/db')).toEqual(['169.254.169.254']);
    expect(mongoUriHosts('mongodb://u@127.0.0.1:27017/db')).toEqual(['127.0.0.1']);
  });
  it('handles credentials that contain an @', () => {
    expect(mongoUriHosts('mongodb://us@er:p@ss@10.0.0.5:27017/db')).toEqual(['10.0.0.5']);
  });
  it('still reads a plain host and a replica set list', () => {
    expect(mongoUriHosts('mongodb://169.254.169.254/db')).toEqual(['169.254.169.254']);
    expect(mongoUriHosts('mongodb://h1:27017,h2:27017/db')).toEqual(['h1', 'h2']);
    expect(mongoUriHosts('mongodb+srv://a:b@cluster0.example.com/db')).toEqual(['cluster0.example.com']);
  });
});
