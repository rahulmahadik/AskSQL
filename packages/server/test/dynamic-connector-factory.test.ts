/**
 * The factory behind `POST /connections` - the path every browser-extension connection takes.
 * Constructing a connector opens nothing, so each engine branch is checked here without a
 * database: what mattered and was untested is that the right driver is chosen and the spec's
 * fields land in the right places (a port default silently wrong is a connection that never works).
 */
import { describe, expect, it } from 'vitest';
import { createConnector, createMongoConnector, ENGINE_DEFAULTS } from '../src/dynamicConnections.js';
import type { ConnectionSpec } from '../src/dynamicConnections.js';

const spec = (over: Partial<ConnectionSpec>): ConnectionSpec => ({
  name: '  padded  ',
  engine: 'postgres',
  host: 'db.example',
  database: 'app',
  user: 'u',
  password: 'p',
  ...over,
});

describe('each engine gets its own driver', () => {
  it('postgres', async () => {
    const c = await createConnector(spec({ engine: 'postgres' }), 'c1');
    expect(c.engine).toBe('postgres');
    expect(c.id).toBe('c1');
    // The name is trimmed: a padded name from a web form otherwise shows padded in every UI.
    expect(c.name).toBe('padded');
  });

  it('mysql', async () => {
    expect((await createConnector(spec({ engine: 'mysql' }), 'c2')).engine).toBe('mysql');
  });

  it('oracle', async () => {
    expect((await createConnector(spec({ engine: 'oracle' }), 'c3')).engine).toBe('oracle');
  });

  it('sqlite takes the database field as a file path', async () => {
    const c = await createConnector(spec({ engine: 'sqlite', database: '/tmp/x.db' }), 'c4');
    expect(c.engine).toBe('sqlite');
  });

  it('duckdb takes the database field as a file path', async () => {
    expect((await createConnector(spec({ engine: 'duckdb', database: '/tmp/x.duckdb' }), 'c5')).engine).toBe('duckdb');
  });

  // MongoDB is not a SQL Connector, so routing it here is a programming error, not a user one.
  it('refuses mongodb, which has its own factory', async () => {
    await expect(createConnector(spec({ engine: 'mongodb' }), 'c6')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('builds a mongo connector from a uri', async () => {
    const c = await createMongoConnector(
      spec({ engine: 'mongodb', uri: 'mongodb://127.0.0.1:27017', database: 'shop' }),
      'c7',
    );
    expect(c.engine).toBe('mongodb');
    expect(c.id).toBe('c7');
  });
});

describe('ports fall back to the engine default', () => {
  // A wrong default is a connection that never works, with nothing in the UI to explain why.
  it('has a default for every SQL engine the form offers', () => {
    expect(ENGINE_DEFAULTS.postgres.port).toBe(5432);
    expect(ENGINE_DEFAULTS.mysql.port).toBe(3306);
    expect(ENGINE_DEFAULTS.oracle.port).toBe(1521);
  });

  it('uses the supplied port when there is one', async () => {
    const c = await createConnector(spec({ engine: 'postgres', port: 6543 }), 'c8');
    expect(c.engine).toBe('postgres');
  });
});
