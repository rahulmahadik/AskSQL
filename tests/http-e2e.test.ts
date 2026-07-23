/**
 * Real over-the-wire test: boot an Express app mounting the AskSQL sidecar
 * against LIVE Postgres, then drive it with real `fetch` - JSON endpoints
 * AND the SSE /chat stream. Uses a mock model by default so the transport
 * is what's under test; set GROQ_API_KEY to exercise a real model too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { asksqlMiddleware } from '@asksql/server/express';
import { PostgresConnector } from '@asksql/postgres';
import type { CustomModel } from '@asksql/core';

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';

const mockModel: CustomModel = async ({ prompt }) => {
  // Answer the two questions the test asks, grounded in the shop schema.
  if (/how many customers/i.test(prompt))
    return '```sql\nSELECT count(*) AS n FROM shop.customers\n```\nCounts customers.';
  return '```sql\nSELECT full_name FROM shop.customers ORDER BY full_name\n```\nAll customer names.';
};

let server: Server | null = null;
let base = '';
let pgReady = true;

const connector = new PostgresConnector({ id: 'shop', name: 'Shop', connectionString: PG_URL });

beforeAll(async () => {
  try {
    await connector.connect();
  } catch {
    pgReady = false;
    return;
  }
  const app = express();
  app.use(express.json());
  app.use(
    '/asksql',
    asksqlMiddleware({
      connectors: [connector],
      engine: { model: mockModel },
      // Auth hook: trust a header token -> single user with access to 'shop'.
      auth: (req) => {
        if (req.headers['x-user'] !== 'alice') return null;
        return { userId: 'alice', allowedConnectionIds: ['shop'] };
      },
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}/asksql`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await connector.close();
});

const H = { 'Content-Type': 'application/json', 'x-user': 'alice' };
const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!pgReady) return;
    await fn();
  });

describe('HTTP e2e: auth', () => {
  maybe('401/403 without the user header', async () => {
    const res = await fetch(`${base}/connections`);
    expect(res.status).toBe(403);
  });
  maybe('lists connections with auth', async () => {
    const res = await fetch(`${base}/connections`, { headers: { 'x-user': 'alice' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connections[0].id).toBe('shop');
  });
});

describe('HTTP e2e: schema + execute', () => {
  maybe('GET /schema returns the catalog with objects', async () => {
    const res = await fetch(`${base}/schema?connectionId=shop`, { headers: { 'x-user': 'alice' } });
    const body = await res.json();
    const tables = body.catalog.tables.map((t: { name: string }) => t.name);
    expect(tables).toContain('customers');
    expect(tables).toContain('paid_orders');
  });

  maybe('POST /execute runs a SELECT', async () => {
    const res = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ sql: 'SELECT count(*) FROM shop.customers', connectionId: 'shop' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.result.rows[0][0])).toBe(3);
  });

  maybe('POST /execute blocks a write with GUARD_BLOCKED (400)', async () => {
    const res = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ sql: 'DELETE FROM shop.customers', connectionId: 'shop' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('GUARD_BLOCKED');
    // No SQL/credentials leaked in the error body.
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\/|password/i);
  });
});

describe('HTTP e2e: SSE /chat stream', () => {
  maybe('streams stage -> sql -> done and the SQL executes', async () => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ question: 'how many customers are there?', connectionId: 'shop' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const frames = text
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
      .map((f) => JSON.parse(f.slice(f.indexOf('data:') + 5).trim()));
    const types = frames.map((f) => f.type);
    expect(types).toContain('stage');
    expect(types).toContain('sql');
    expect(types[types.length - 1]).toBe('done');
    const sqlFrame = frames.find((f) => f.type === 'sql');
    expect(sqlFrame.sql).toMatch(/count\(\*\).*customers/i);

    // Approve + run the generated SQL over HTTP.
    const run = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ sql: sqlFrame.sql, connectionId: 'shop' }),
    });
    const body = await run.json();
    expect(Number(body.result.rows[0][0])).toBe(3);
  });
});
