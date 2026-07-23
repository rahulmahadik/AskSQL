/**
 * OPFS persistence in a real browser. Opens a DuckDB-WASM connector
 * backed by the Origin Private File System, writes a persistent table, closes
 * it, then opens a FRESH connector against the same OPFS path and confirms the
 * table survived - the mechanism behind "reload keeps your data".
 *
 * Skips when OPFS/Chrome/the built demo is unavailable (OPFS needs a secure
 * context; some headless configurations disable it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { resolveChrome } from './chrome.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'examples', 'browser-duckdb', 'dist');
const CHROME = resolveChrome();
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
};

let browser: Browser | null = null;
let server: Server | null = null;
let base = '';
let ready = existsSync(dist) && !!CHROME;

beforeAll(async () => {
  if (!ready) return;
  server = createServer(async (req, res) => {
    const file = (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : (req.url ?? '/').slice(1);
    try {
      const body = await readFile(join(dist, file));
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('nf');
    }
  });
  await new Promise<void>((r) =>
    server!.listen(0, () => {
      const a = server!.address();
      base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/`;
      r();
    }),
  );
  try {
    const pptr = await import('puppeteer-core');
    browser = await pptr.default.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  } catch {
    ready = false;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

describe('OPFS persistence across connector reopen', () => {
  it('a persistent table written by one connector is visible to a fresh one', async () => {
    if (!ready || !browser) {
      console.warn('[skip] browser-opfs - Chrome/built demo/OPFS unavailable');
      return;
    }
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!(window as unknown as { __asksql?: unknown }).__asksql, { timeout: 15_000 });

    const outcome = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          __asksql: {
            DuckDbWasmConnector: new (c: object) => {
              connect(): Promise<void>;
              execute(sql: string, o?: object): Promise<{ rows: unknown[][] }>;
              close(): Promise<void>;
            };
            BUNDLES: object;
          };
        }
      ).__asksql;
      const path = 'opfs://asksql-persist-test.db';
      try {
        // Connector A: create a persistent table with data.
        const a = new api.DuckDbWasmConnector({ id: 'a', name: 'A', bundles: api.BUNDLES, persistPath: path });
        await a.connect();
        await a.execute('CREATE TABLE IF NOT EXISTS kept (id INTEGER, note VARCHAR)');
        await a.execute('DELETE FROM kept');
        await a.execute("INSERT INTO kept VALUES (1,'hello'), (2,'world')");
        await a.execute('CHECKPOINT');
        await a.close();

        // Connector B: fresh instance, same OPFS path - the table must survive.
        const b = new api.DuckDbWasmConnector({ id: 'b', name: 'B', bundles: api.BUNDLES, persistPath: path });
        await b.connect();
        const res = await b.execute('SELECT count(*) AS n FROM kept');
        const n = Number((res.rows[0] as unknown[])[0]);
        await b.close();
        return { ok: true, n };
      } catch (err) {
        return { ok: false, error: String((err as { message?: string }).message ?? err) };
      }
    });

    if (!outcome.ok && /opfs|not supported|SecurityError|NotAllowed/i.test(outcome.error ?? '')) {
      console.warn('[skip] OPFS not available in this headless config:', outcome.error);
      return;
    }
    expect(outcome.ok).toBe(true);
    expect(outcome.n).toBe(2); // the 2 rows persisted across the reopen
    await page.close();
  }, 120_000);
});
