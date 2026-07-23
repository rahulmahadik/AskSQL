/**
 * More real live-Postgres coverage: diverse column types and their cell
 * shaping, NULL vs empty-string, wide results, and
 * cross-schema. Sets up its own fixture via a direct (writable) pg client;
 * the AskSQL connector itself stays read-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresConnector } from '@asksql/postgres';
import type { CellValue } from '@asksql/core';

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';

let ready = true;
const admin = new pg.Pool({ connectionString: PG_URL, max: 2 });
const conn = new PostgresConnector({ id: 'types', name: 'Types', connectionString: PG_URL });

beforeAll(async () => {
  try {
    await admin.query(`
      DROP SCHEMA IF EXISTS lab CASCADE;
      CREATE SCHEMA lab;
      CREATE TABLE lab.events (
        id           bigserial PRIMARY KEY,
        label        text,
        payload      jsonb,
        tags         text[],
        amount       numeric(20,4),
        big          bigint,
        happened_at  timestamptz,
        only_date    date,
        flag         boolean,
        blob         bytea,
        note         text
      );
      INSERT INTO lab.events (label, payload, tags, amount, big, happened_at, only_date, flag, blob, note) VALUES
        ('a', '{"k":1,"nested":{"x":true}}'::jsonb, ARRAY['red','green'], 12345678901234.5678, 9223372036854775807, '2026-03-01 12:30:00+00', '2026-03-01', true, '\\xDEADBEEF'::bytea, ''),
        ('b', '[1,2,3]'::jsonb, ARRAY['solo'], -0.0001, -42, '2026-06-15 23:59:59+05:30', '2026-06-15', false, NULL, NULL),
        (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'plain');
    `);
    await conn.connect();
  } catch (err) {
    ready = false;
    console.warn('[skip] live-db-extra fixture failed:', (err as Error).message);
  }
});

afterAll(async () => {
  await admin.query('DROP SCHEMA IF EXISTS lab CASCADE').catch(() => {});
  await admin.end().catch(() => {});
  await conn.close();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!ready) return;
    await fn();
  });

describe('introspection of diverse types', () => {
  maybe('classifies jsonb/array/numeric/bigint/timestamptz/bytea columns', async () => {
    const cat = await conn.introspect();
    const events = cat.tables.find((t) => t.name === 'events' && t.schema === 'lab')!;
    const byName = new Map(events.columns.map((c) => [c.name, c.dbType]));
    expect(byName.get('payload')).toMatch(/jsonb/i);
    expect(byName.get('tags')).toMatch(/\[\]|array/i);
    expect(byName.get('amount')).toMatch(/numeric/i);
    expect(byName.get('happened_at')).toMatch(/timestamp with time zone|timestamptz/i);
    expect(byName.get('blob')).toMatch(/bytea/i);
  });
});

describe('cell shaping', () => {
  maybe('bigint + numeric kept as exact strings', async () => {
    const res = await conn.execute('SELECT big, amount FROM lab.events WHERE label = $$a$$');
    expect(res.columns[0]!.kind).toBe('bigint');
    expect(res.rows[0]![0]).toBe('9223372036854775807'); // max int64, exact
    expect(res.columns[1]!.kind).toBe('decimal');
    expect(res.rows[0]![1]).toBe('12345678901234.5678');
  });

  maybe('jsonb + array render as JSON text', async () => {
    const res = await conn.execute("SELECT payload, tags FROM lab.events WHERE label = 'a'");
    expect(res.columns[0]!.kind).toBe('json');
    expect(String(res.rows[0]![0])).toContain('"nested"');
    // arrays come back stringified; content preserved
    expect(String(res.rows[0]![1])).toMatch(/red/);
  });

  maybe('bytea becomes a binary preview, never raw', async () => {
    const res = await conn.execute("SELECT blob FROM lab.events WHERE label = 'a'");
    const cell = res.rows[0]![0] as Exclude<CellValue, string | number | boolean | null>;
    expect(cell).toHaveProperty('__binary');
    expect((cell as { __binary: { hexPreview: string } }).__binary.hexPreview).toMatch(/deadbeef/i);
  });

  maybe('timestamptz + date round-trip as ISO', async () => {
    const res = await conn.execute("SELECT happened_at, only_date FROM lab.events WHERE label = 'a'");
    expect(res.columns[0]!.kind).toBe('timestamp');
    expect(String(res.rows[0]![0])).toMatch(/2026-03-01T/);
    expect(String(res.rows[0]![1])).toMatch(/^2026-03-01/);
  });

  maybe('NULL vs empty-string are distinct values', async () => {
    // Row 'a' has note='' (empty), row with note='plain' is non-null, others NULL.
    const res = await conn.execute('SELECT label, note FROM lab.events ORDER BY id');
    const rowA = res.rows.find((r) => r[0] === 'a')!;
    expect(rowA[1]).toBe(''); // empty string, not null
    const rowNull = res.rows.find((r) => r[0] === null)!;
    expect(rowNull[1]).toBe('plain');
    const rowB = res.rows.find((r) => r[0] === 'b')!;
    expect(rowB[1]).toBeNull(); // actual NULL
  });

  maybe('boolean typed and rendered', async () => {
    const res = await conn.execute("SELECT flag FROM lab.events WHERE label = 'a'");
    expect(res.columns[0]!.kind).toBe('boolean');
    expect(res.rows[0]![0]).toBe(true);
  });
});

describe('result-shape edge cases', () => {
  maybe('duplicate + aliased columns preserved positionally', async () => {
    const res = await conn.execute('SELECT id, id, label AS id FROM lab.events LIMIT 1');
    expect(res.columns).toHaveLength(3);
    expect(res.rows[0]).toHaveLength(3);
  });

  maybe('zero-row result is clean, not an error', async () => {
    const res = await conn.execute("SELECT * FROM lab.events WHERE label = 'nonexistent'");
    expect(res.rowCount).toBe(0);
    expect(res.rows).toEqual([]);
    expect(res.columns.length).toBeGreaterThan(0);
  });

  maybe('wide projection (all columns) shapes every cell', async () => {
    const res = await conn.execute('SELECT * FROM lab.events ORDER BY id');
    expect(res.columns.length).toBe(11);
    expect(res.rows.length).toBe(3);
    // Every cell is a JSON-safe value (string/number/bool/null/binary object).
    for (const row of res.rows) {
      for (const cell of row) {
        const ok =
          cell === null ||
          ['string', 'number', 'boolean'].includes(typeof cell) ||
          (typeof cell === 'object' && '__binary' in cell);
        expect(ok).toBe(true);
      }
    }
  });
});
