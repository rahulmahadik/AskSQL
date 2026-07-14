/**
 * The zero-backend product wedge, proven in a real browser:
 * Chrome -> built Vite bundle -> DuckDB-WASM (Web Worker) -> @asksql/core engine
 * + guard -> LocalTransport -> AskSqlChat - NO server, NO network for the data.
 *
 * Uploads a CSV, injects a deterministic CustomModel (so no LLM key/network is
 * needed), asks a question, and asserts the result renders - meaning the file
 * was parsed and queried entirely in the tab.
 *
 * Skips when the built demo dist or Chrome is unavailable.
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
const csv = join(here, '..', 'examples', 'browser-duckdb', 'sales.csv');
const CHROME = resolveChrome();

const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
};

let browser: Browser | null = null;
let server: Server | null = null;
let base = '';
let ready = existsSync(dist) && !!CHROME;

beforeAll(async () => {
  if (!ready) return;
  server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    const file = url === '/' ? 'index.html' : url.slice(1);
    try {
      const body = await readFile(join(dist, file));
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      // Enable cross-origin isolation so DuckDB-WASM can pick the faster bundle
      // (MVP works without it too).
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('nf');
    }
  });
  await new Promise<void>((r) => {
    server!.listen(0, () => {
      const a = server!.address();
      base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/`;
      r();
    });
  });
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

describe('zero-backend browser client-only mode', () => {
  it(
    'upload CSV -> DuckDB-WASM -> ask -> guarded SQL -> results, all in-tab',
    async () => {
      if (!ready || !browser) {
        console.warn('[skip] browser-duckdb - build the demo (vite build) + Chrome required');
        return;
      }
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));

      // Inject a deterministic model BEFORE the app loads (no LLM key/network).
      await page.evaluateOnNewDocument(() => {
        (window as unknown as { __asksqlModel: unknown }).__asksqlModel = async ({ prompt }: { prompt: string }) => {
          // The schema block names the table (from the filename "sales").
          const table = /TABLE\s+(\w+)/i.exec(prompt)?.[1] ?? 'sales';
          if (/how many|count|number of rows/i.test(prompt)) {
            return '```sql\nSELECT count(*) AS n FROM ' + table + '\n```\nCounts the rows.';
          }
          return '```sql\nSELECT * FROM ' + table + ' LIMIT 5\n```\nFirst rows.';
        };
      });

      await page.goto(base, { waitUntil: 'networkidle0' });

      // Upload the CSV into the file input.
      const input = await page.$('input[data-testid="file"]');
      await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(csv);

      // Wait until DuckDB-WASM has loaded the file and the chat is ready.
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="status"]')?.textContent ?? '').includes('Ready'),
        { timeout: 60_000 },
      );

      // Ask a question - the whole ask->SQL->guard->execute loop runs in-browser.
      await page.waitForSelector('.asksql-input textarea', { timeout: 10_000 });
      await page.type('.asksql-input textarea', 'How many rows are there?');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.asksql-sqlcode', { timeout: 30_000 });
      const sql = await page.$eval('.asksql-sqlcode', (el) => el.textContent ?? '');
      expect(sql.toLowerCase()).toContain('count(*)');

      // Run it - DuckDB-WASM executes over the uploaded file, in-tab.
      for (const b of await page.$$('.asksql-btn-primary')) {
        const t = await b.evaluate((el) => el.textContent);
        if (t && /run query/i.test(t)) { await b.click(); break; }
      }
      await page.waitForSelector('.asksql-table', { timeout: 30_000 });
      const cell = await page.$eval('.asksql-table td', (el) => el.textContent ?? '');
      expect(cell.trim()).toBe('5'); // 5 rows in sales.csv

      expect(errors).toEqual([]);
      await page.close();
    },
    120_000,
  );
});
