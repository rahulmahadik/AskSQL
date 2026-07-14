/**
 * The whole product, exercised as a user would:
 *
 *   real Chrome UI  ->  Vite-built React app  ->  HTTP  ->  Express sidecar
 *   ->  server-side guard  ->  live Postgres  ->  real LLM (Groq/Ollama)
 *
 * Boots the Express sidecar (live PG + real model) and serves the built
 * vite-react bundle, then drives the actual DOM: type a question, watch the
 * SQL stream in, click "Run query", read the rendered result table.
 *
 * Requires: built vite-react dist, Chrome, live Postgres, and a model
 * (GROQ_API_KEY or local Ollama). Skips otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { resolveChrome } from './chrome.js';
import { asksqlMiddleware } from '@asksql/server/express';
import { PostgresConnector } from '@asksql/postgres';
import { resolveModel } from '@asksql/core';

const here = dirname(fileURLToPath(import.meta.url));
const viteDist = join(here, '..', 'examples', 'vite-react', 'dist');
const CHROME = resolveChrome();
const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';

async function pickModel() {
  if (process.env['GROQ_API_KEY']) return resolveModel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: process.env['GROQ_API_KEY'] });
  // Probe Ollama.
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (r.ok) return resolveModel({ provider: 'ollama', model: process.env['ASKSQL_OLLAMA_MODEL'] ?? 'qwen2.5-coder:14b', baseURL: 'http://localhost:11434/v1' });
  } catch {
    /* fall through */
  }
  return null;
}

let browser: Browser | null = null;
let apiServer: Server | null = null;
let webServer: Server | null = null;
let webBase = '';
let ready = existsSync(viteDist) && !!CHROME;
const connector = new PostgresConnector({ id: 'shop', name: 'Shop DB', connectionString: PG_URL });

beforeAll(async () => {
  if (!ready) return;
  const model = await pickModel();
  try {
    await connector.connect();
  } catch {
    ready = false;
    return;
  }
  if (!model) {
    ready = false;
    return;
  }

  // One Express app serves BOTH the built bundle and the sidecar on the
  // same origin (localhost:4000) - the bundle calls /asksql there, so no
  // cross-origin/CORS issue (this mirrors the express-postgres demo).
  // Expose TWO connections so the picker appears in the UI.
  const connector2 = new PostgresConnector({ id: 'shop2', name: 'Reporting DB', connectionString: PG_URL });
  const app = express();
  app.use(express.json());
  app.use('/asksql', asksqlMiddleware({
    connectors: [connector, connector2],
    engine: { model, policy: { maxRows: 100 } },
    auth: () => ({ userId: 'demo', allowedConnectionIds: ['shop', 'shop2'] }),
  }));
  app.use(express.static(viteDist));
  await new Promise<void>((r) => { apiServer = app.listen(4000, () => r()); });
  webBase = 'http://localhost:4000/';

  try {
    const pptr = await import('puppeteer-core');
    browser = await pptr.default.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  } catch {
    ready = false;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => (apiServer ? apiServer.close(() => r()) : r()));
  await new Promise<void>((r) => (webServer ? webServer.close(() => r()) : r()));
  await connector.close();
});

describe('full-stack browser E2E', () => {
  it(
    'type a question -> SQL streams in -> Run -> result table renders',
    async () => {
      if (!ready || !browser) {
        console.warn('[skip] full-stack E2E - needs built vite dist, Chrome, PG, and a model');
        return;
      }
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(webBase, { waitUntil: 'networkidle0' });

      // Type into the chat textarea and submit.
      await page.waitForSelector('.asksql-input textarea', { timeout: 10_000 });
      await page.type('.asksql-input textarea', 'How many customers are there?');
      await page.keyboard.press('Enter');

      // The generated SQL block appears (streamed via SSE).
      await page.waitForSelector('.asksql-sqlcode', { timeout: 60_000 });
      const sql = await page.$eval('.asksql-sqlcode', (el) => el.textContent ?? '');
      expect(sql.toLowerCase()).toContain('customers');

      // Approve: click "Run query".
      await page.waitForSelector('.asksql-btn-primary', { timeout: 10_000 });
      const buttons = await page.$$('.asksql-btn-primary');
      for (const b of buttons) {
        const label = await b.evaluate((el) => el.textContent);
        if (label && /run query/i.test(label)) {
          await b.click();
          break;
        }
      }

      // The result table renders with the answer (3 customers).
      await page.waitForSelector('.asksql-table', { timeout: 30_000 });
      const cell = await page.$eval('.asksql-table td', (el) => el.textContent ?? '');
      expect(cell.trim()).toBe('3');

      // the connection picker is present (two connections exposed).
      const hasPicker = await page.$('.asksql-picker select');
      expect(hasPicker).not.toBeNull();
      const options = await page.$$eval('.asksql-picker select option', (opts) => opts.map((o) => o.textContent));
      expect(options.length).toBe(2);

      expect(errors).toEqual([]);
      await page.close();
    },
    120_000,
  );

  it(
    'a category+numeric result renders a chart on toggle',
    async () => {
      if (!ready || !browser) return;
      const page = await browser.newPage();
      await page.goto(webBase, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.asksql-input textarea', { timeout: 10_000 });
      await page.type('.asksql-input textarea', 'What is the total order amount in cents for each customer region?');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.asksql-sqlcode', { timeout: 60_000 });
      for (const b of await page.$$('.asksql-btn-primary')) {
        const t = await b.evaluate((el) => el.textContent);
        if (t && /run query/i.test(t)) { await b.click(); break; }
      }
      await page.waitForSelector('.asksql-table', { timeout: 30_000 });
      // A "Chart" toggle appears; clicking it renders an SVG.
      let clicked = false;
      for (const b of await page.$$('.asksql-btn')) {
        const t = await b.evaluate((el) => el.textContent);
        if (t && /^chart$/i.test(t.trim())) { await b.click(); clicked = true; break; }
      }
      expect(clicked).toBe(true);
      await page.waitForSelector('.asksql-chart svg', { timeout: 5000 });
      const bars = await page.$$eval('.asksql-chart svg rect', (els) => els.length);
      expect(bars).toBeGreaterThan(0);
      await page.close();
    },
    120_000,
  );

  it(
    'offline mid-session shows a clean error, then recovers online',
    async () => {
      if (!ready || !browser) return;
      const page = await browser.newPage();
      await page.goto(webBase, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.asksql-input textarea', { timeout: 10_000 });
      await page.setOfflineMode(true);
      await page.type('.asksql-input textarea', 'How many customers are there?');
      await page.keyboard.press('Enter');
      // A clean error state appears (not a crash / infinite spinner).
      await page.waitForSelector('.asksql-error', { timeout: 15_000 });
      const msg = await page.$eval('.asksql-error', (el) => el.textContent ?? '');
      expect(msg.length).toBeGreaterThan(0);
      // Back online -> a new question works.
      await page.setOfflineMode(false);
      await page.type('.asksql-input textarea', 'How many customers are there?');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.asksql-sqlcode', { timeout: 60_000 });
      await page.close();
    },
    120_000,
  );

  it(
    'navigating away during generation leaves no uncaught error',
    async () => {
      if (!ready || !browser) return;
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(webBase, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.asksql-input textarea', { timeout: 10_000 });
      await page.type('.asksql-input textarea', 'How many customers are there?');
      await page.keyboard.press('Enter');
      // Reload WHILE the generation is in flight (abort-on-unmount must be clean).
      await new Promise((r) => setTimeout(r, 150));
      await page.reload({ waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 300));
      expect(pageErrors).toEqual([]);
      await page.close();
    },
    120_000,
  );

  it(
    'edit the generated SQL, save, run - the edited query executes',
    async () => {
      if (!ready || !browser) return;
      const page = await browser.newPage();
      await page.goto(webBase, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.asksql-input textarea', { timeout: 10_000 });
      await page.type('.asksql-input textarea', 'How many customers are there?');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.asksql-sqlcode', { timeout: 60_000 });

      // Click "Edit", replace the SQL with a different valid query, Save.
      const editBtn = await page.$$('.asksql-btn');
      for (const b of editBtn) {
        const t = await b.evaluate((el) => el.textContent);
        if (t && /^edit$/i.test(t.trim())) { await b.click(); break; }
      }
      await page.waitForSelector('.asksql-sqledit', { timeout: 5000 });
      await page.evaluate(() => { (document.querySelector('.asksql-sqledit') as HTMLTextAreaElement).value = ''; });
      await page.type('.asksql-sqledit', 'SELECT count(*) FROM shop.orders');
      // Click Save.
      for (const b of await page.$$('.asksql-btn-primary')) {
        const t = await b.evaluate((el) => el.textContent);
        if (t && /save/i.test(t)) { await b.click(); break; }
      }
      // Auto-run mode (the demo default): saving the edit runs it immediately,
      // so the result table appears without a separate Run click.
      await page.waitForSelector('.asksql-table', { timeout: 30_000 });
      const cell = await page.$eval('.asksql-table td', (el) => el.textContent ?? '');
      expect(cell.trim()).toBe('4'); // orders count, from the EDITED query
      await page.close();
    },
    120_000,
  );
});
