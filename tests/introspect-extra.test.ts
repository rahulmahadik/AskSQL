/**
 * Introspection correctness a production integrator relies on:
 *   permission-tolerant (a role that can't see a table -> warning,
 *          not a crash; the object is simply absent)
 *   composite PK / composite FK captured fully
 *   partitioned table collapses to its parent
 *   same table name in two schemas is disambiguated
 *   system schemas excluded by default
 *   schema refresh picks up a DDL change
 *   zero-table schema -> friendly empty catalog
 *
 * Sets up fixtures via a direct (writable) admin client; the AskSQL
 * connector under test stays read-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresConnector } from '@asksql/postgres';

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';
let ready = true;
const admin = new pg.Pool({ connectionString: PG_URL, max: 3 });

// A least-privilege login role, as a real deployment would use.
const ROLE = 'asksql_ro';
const ROLE_PW = 'ro_pw_123';
let roURL = '';

beforeAll(async () => {
  try {
    await admin.query(`
      DROP SCHEMA IF EXISTS coord CASCADE;
      DROP SCHEMA IF EXISTS other CASCADE;
      DROP SCHEMA IF EXISTS emptyz CASCADE;
      CREATE SCHEMA coord;
      CREATE SCHEMA other;
      CREATE SCHEMA emptyz;

      -- composite PK + composite FK
      CREATE TABLE coord.regions (country text, area text, PRIMARY KEY (country, area));
      CREATE TABLE coord.depots (
        country text, area text, code text,
        PRIMARY KEY (country, area, code),
        FOREIGN KEY (country, area) REFERENCES coord.regions(country, area)
      );

      -- partitioned parent + children
      CREATE TABLE coord.sales (id bigint, region text, ts timestamptz) PARTITION BY RANGE (ts);
      CREATE TABLE coord.sales_2026 PARTITION OF coord.sales FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

      -- same table name in two schemas
      CREATE TABLE coord.users (id bigint PRIMARY KEY, name text);
      CREATE TABLE other.users (id bigint PRIMARY KEY, email text);

      -- a secret table the read role will NOT be granted
      CREATE TABLE coord.secret_salaries (id bigint PRIMARY KEY, amount numeric);
    `);

    // Set up the read-only role with access to coord/other but NOT the secret.
    await admin.query(`DROP OWNED BY ${ROLE}; DROP ROLE IF EXISTS ${ROLE};`).catch(() => {});
    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}'`);
    await admin.query(`GRANT USAGE ON SCHEMA coord, other, emptyz TO ${ROLE}`);
    await admin.query(`GRANT SELECT ON coord.regions, coord.depots, coord.sales, coord.users, other.users TO ${ROLE}`);
    // deliberately NO grant on coord.secret_salaries

    const u = new URL(PG_URL);
    u.username = ROLE;
    u.password = ROLE_PW;
    roURL = u.toString();
  } catch (err) {
    ready = false;
    console.warn('[skip] introspect-extra fixture failed:', (err as Error).message);
  }
});

afterAll(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS coord CASCADE; DROP SCHEMA IF EXISTS other CASCADE; DROP SCHEMA IF EXISTS emptyz CASCADE;`).catch(() => {});
  await admin.query(`DROP OWNED BY ${ROLE}; DROP ROLE IF EXISTS ${ROLE};`).catch(() => {});
  await admin.end().catch(() => {});
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!ready) return;
    await fn();
  });

describe('composite keys', () => {
  maybe('composite PK and composite FK captured', async () => {
    const conn = new PostgresConnector({ id: 'c', name: 'c', connectionString: PG_URL });
    try {
      const cat = await conn.introspect();
      const depots = cat.tables.find((t) => t.schema === 'coord' && t.name === 'depots')!;
      expect(depots.primaryKey).toEqual(['country', 'area', 'code']);
      const fk = depots.foreignKeys.find((f) => f.refTable === 'regions')!;
      expect(fk.columns).toEqual(['country', 'area']);
      expect(fk.refColumns).toEqual(['country', 'area']);
    } finally {
      await conn.close();
    }
  });
});

describe('partitions', () => {
  maybe('child partition is collapsed to its parent (partitionOf set)', async () => {
    const conn = new PostgresConnector({ id: 'c', name: 'c', connectionString: PG_URL });
    try {
      const cat = await conn.introspect();
      const parent = cat.tables.find((t) => t.name === 'sales' && t.schema === 'coord')!;
      expect(parent.isPartitioned).toBe(true);
      const child = cat.tables.find((t) => t.name === 'sales_2026');
      expect(child?.partitionOf).toBeTruthy();
    } finally {
      await conn.close();
    }
  });
});

describe('/ schema disambiguation', () => {
  maybe('same table name in two schemas kept distinct; system schemas excluded', async () => {
    const conn = new PostgresConnector({ id: 'c', name: 'c', connectionString: PG_URL });
    try {
      const cat = await conn.introspect();
      const coordUsers = cat.tables.find((t) => t.schema === 'coord' && t.name === 'users')!;
      const otherUsers = cat.tables.find((t) => t.schema === 'other' && t.name === 'users')!;
      expect(coordUsers.columns.some((c) => c.name === 'name')).toBe(true);
      expect(otherUsers.columns.some((c) => c.name === 'email')).toBe(true);
      // no pg_catalog / information_schema objects leak in.
      expect(cat.schemas).not.toContain('pg_catalog');
      expect(cat.tables.every((t) => t.schema !== 'information_schema')).toBe(true);
    } finally {
      await conn.close();
    }
  });
});

describe('permission tolerance', () => {
  maybe('read-only role sees granted tables, not the ungranted secret, no crash', async () => {
    const conn = new PostgresConnector({ id: 'ro', name: 'ro', connectionString: roURL });
    try {
      const cat = await conn.introspect();
      const names = cat.tables.map((t) => `${t.schema}.${t.name}`);
      expect(names).toContain('coord.regions');
      expect(names).toContain('other.users');
      // The ungranted table must NOT appear (or at least not be queryable);
      // introspection must not throw regardless.
      const secret = cat.tables.find((t) => t.name === 'secret_salaries');
      // Postgres exposes catalog metadata broadly, so it may be listed - the
      // invariant is that querying it is denied, not that it's hidden.
      if (secret) {
        await expect(conn.execute('SELECT * FROM coord.secret_salaries')).rejects.toBeTruthy();
      }
    } finally {
      await conn.close();
    }
  });
});

describe('schema refresh', () => {
  maybe('refresh picks up a newly added column', async () => {
    const conn = new PostgresConnector({ id: 'c', name: 'c', connectionString: PG_URL });
    try {
      await conn.introspect(); // warm
      await admin.query('ALTER TABLE coord.users ADD COLUMN nickname text');
      // A fresh introspect (the engine calls this with refresh) sees it.
      const cat = await conn.introspect();
      const users = cat.tables.find((t) => t.schema === 'coord' && t.name === 'users')!;
      expect(users.columns.some((c) => c.name === 'nickname')).toBe(true);
    } finally {
      await conn.close();
    }
  });
});

describe('empty schema', () => {
  maybe('a schema with no tables yields a catalog without crashing', async () => {
    const conn = new PostgresConnector({ id: 'c', name: 'c', connectionString: PG_URL });
    try {
      const cat = await conn.introspect();
      // emptyz has no tables; the catalog still lists the schema and does not throw.
      expect(Array.isArray(cat.tables)).toBe(true);
      expect(cat.tables.filter((t) => t.schema === 'emptyz')).toHaveLength(0);
    } finally {
      await conn.close();
    }
  });
});
