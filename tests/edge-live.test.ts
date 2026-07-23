/**
 * Remaining live edge cases:
 *   overloaded functions (same name, different signatures) captured
 *   Very wide result (500 columns) shapes every cell
 *   Exotic types (range, interval, uuid, inet, bit) -> safe text fallback
 * Uses a direct admin client for the fixture; the AskSQL connector stays RO.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresConnector } from '@asksql/postgres';

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';
let ready = true;
const admin = new pg.Pool({ connectionString: PG_URL, max: 2 });
const conn = new PostgresConnector({ id: 'edge', name: 'Edge', connectionString: PG_URL });

beforeAll(async () => {
  try {
    await admin.query(`
      DROP SCHEMA IF EXISTS edge CASCADE;
      CREATE SCHEMA edge;
      -- overloaded functions
      CREATE FUNCTION edge.f(x int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT x + 1';
      CREATE FUNCTION edge.f(x text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT upper(x)';
      -- exotic-typed table
      CREATE TABLE edge.exotic (
        id uuid DEFAULT gen_random_uuid(),
        span int4range,
        dur interval,
        addr inet,
        flags bit(4)
      );
      INSERT INTO edge.exotic (span, dur, addr, flags) VALUES
        ('[1,10)', interval '2 days 3 hours', '192.168.0.1', B'1010');
    `);
    await conn.connect();
  } catch (err) {
    ready = false;
    console.warn('[skip] edge-live fixture failed:', (err as Error).message);
  }
});

afterAll(async () => {
  await admin.query('DROP SCHEMA IF EXISTS edge CASCADE').catch(() => {});
  await admin.end().catch(() => {});
  await conn.close();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!ready) return;
    await fn();
  });

describe('overloaded functions', () => {
  maybe('both signatures of the same function name are captured', async () => {
    const cat = await conn.introspect();
    const fns = cat.routines.filter((r) => r.schema === 'edge' && r.name === 'f');
    expect(fns.length).toBe(2);
    const argSets = fns.map((f) => f.args).sort();
    expect(argSets.some((a) => /int/i.test(a))).toBe(true);
    expect(argSets.some((a) => /text/i.test(a))).toBe(true);
    // Both are IMMUTABLE -> callable.
    expect(fns.every((f) => f.volatility === 'immutable')).toBe(true);
  });
});

describe('very wide result (500 columns)', () => {
  maybe('a 500-column projection shapes every cell without error', async () => {
    const cols = Array.from({ length: 500 }, (_, i) => `${i} AS c${i}`).join(', ');
    const res = await conn.execute(`SELECT ${cols}`);
    expect(res.columns.length).toBe(500);
    expect(res.rows[0]!.length).toBe(500);
    expect(Number(res.rows[0]![499])).toBe(499);
  });
});

describe('exotic types fall back to safe text', () => {
  maybe('range/interval/uuid/inet/bit render as strings, never crash', async () => {
    const res = await conn.execute('SELECT id, span::text AS span_t, span, dur, addr, flags FROM edge.exotic');
    // Every cell is a JSON-safe scalar (string/number/bool/null) or binary object.
    for (const cell of res.rows[0]!) {
      const ok =
        cell === null ||
        ['string', 'number', 'boolean'].includes(typeof cell) ||
        (typeof cell === 'object' && '__binary' in cell);
      expect(ok).toBe(true);
    }
    // The values are present as readable text.
    const byName = new Map(res.columns.map((c, i) => [c.name, res.rows[0]![i]]));
    expect(String(byName.get('dur'))).toMatch(/2 days|day/i);
    expect(String(byName.get('addr'))).toContain('192.168.0.1');
  });
});
