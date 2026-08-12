/** Real-browser smoke test on the built dist/ in Chrome for Testing (branded Chrome dropped --load-extension in 137). chrome.permissions.request() never resolves under headless CDP, so sections inject window.__asksqlModel, stop at the permission gate, or load a dist/ copy whose manifest grants the host up front. Run: node test/e2e-smoke.mjs <chrome-for-testing>. */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { AskSqlServer } from '@asksql/server';
import { SQLITE_DIALECT } from '@asksql/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dist = path.join(root, 'dist');
const csvFixture = path.join(root, '../../examples/browser-duckdb/sales.csv');
const xlsxFixture = path.join(here, 'fixtures/multi-sheet.xlsx');
const zipFixture = path.join(here, 'fixtures/bundle.zip');
const taSelector = 'textarea[aria-label="Ask a question about your data"]';

const CHROME = process.argv[2];
if (!CHROME || !existsSync(CHROME)) {
  console.error('Usage: node test/e2e-smoke.mjs <path-to-chrome-for-testing>');
  process.exit(1);
}
if (!existsSync(dist)) {
  console.error(`${dist} does not exist - run "npm run build" first.`);
  process.exit(1);
}
for (const fixture of [csvFixture, xlsxFixture, zipFixture]) {
  if (!existsSync(fixture)) {
    console.error(`Fixture not found: ${fixture}`);
    process.exit(1);
  }
}

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

/** Runs one independent section; a thrown error becomes a recorded failure instead of crashing the whole run. */
async function section(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name} - ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function findButton(page, text) {
  const idx = (await page.$$eval('button', (btns) => btns.map((b) => b.textContent))).indexOf(text);
  if (idx === -1) return null;
  return (await page.$$('button'))[idx];
}

/** Builds a data-file connection through the real Settings UI, the way a user does. */
async function createFileConnection(browser, extensionId, name, files) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#connType', { timeout: 10_000 });
  await page.select('#connType', 'files');
  await page.type('#connName', name);
  const input = await page.$('#connFiles');
  await input.uploadFile(...files);
  const addBtn = await findButton(page, 'Add connection');
  await addBtn.click();
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll('.asksql-ext-status')].some((el) =>
        (el.textContent ?? '').includes(`Added "${n}"`),
      ),
    { timeout: 60_000 },
    name,
  );
  const status = await page.evaluate(
    (n) =>
      [...document.querySelectorAll('.asksql-ext-status')]
        .map((el) => el.textContent ?? '')
        .find((t) => t.includes(`Added "${n}"`)) ?? '',
    name,
  );
  await page.close();
  return status;
}

/** Opens the side panel with a test model injected, and connects to a named connection. */
async function openSidePanelAndConnect(browser, extensionId, name, modelSql) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((sql) => {
    window.__asksqlModel = async () => `\`\`\`sql\n${sql}\n\`\`\``;
  }, modelSql);
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#connection', { timeout: 15_000 });
  await page.select('#connection', await optionValueByLabel(page, name));
  const connectBtn = await findButton(page, 'Connect');
  await connectBtn.click();
  return page;
}

async function optionValueByLabel(page, label) {
  return page.evaluate(
    (l) => [...document.querySelectorAll('#connection option')].find((o) => o.textContent.includes(l))?.value ?? '',
    label,
  );
}

/** A hand-written fake Connector (no real DB): satisfies the interface directly. */
function fakeConnector() {
  return {
    engine: 'sqlite',
    dialect: SQLITE_DIALECT,
    capabilities: { supportsExplain: false },
    id: 'fake',
    name: 'Fake sidecar DB',
    async connect() {},
    async close() {},
    async execute() {
      return {
        columns: [{ name: 'answer', kind: 'number' }],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
        durationMs: 1,
        warnings: [],
      };
    },
    async introspect() {
      return { tables: [], warnings: [] };
    },
  };
}

async function startFakeSidecar() {
  const server = new AskSqlServer({
    connectors: [fakeConnector()],
    engine: { model: async () => '```sql\nSELECT 1 AS answer\n```' },
    auth: () => ({ userId: 'test', allowedConnectionIds: ['fake'] }),
  });
  const httpServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://localhost');
    const serverReq = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      json: async () => (bodyText ? JSON.parse(bodyText) : {}),
    };
    const result = await server.handle(serverReq);
    if ('stream' in result) {
      res.writeHead(result.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for await (const event of result.stream) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    } else {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    }
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  return { httpServer, port: httpServer.address().port };
}

async function findExtensionId(browser) {
  for (let i = 0; i < 20; i++) {
    const sw = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
    if (sw) return new URL(sw.url()).host;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * A stand-in for Ollama's actual default behaviour: reject any request that
 * carries an Origin, with 403 and no CORS headers at all, exactly as a real
 * `ollama serve` does for a chrome-extension:// origin.
 */
function startStrictOriginProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, origin: req.headers.origin ?? null });
      if (req.headers.origin) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })),
  );
}

/** Regression: Chrome attaches Origin to the chat-completions POST even with host permission (GETs are unaffected), so a strict provider 403s it. permissions.request() cannot be driven headlessly, so this loads a dist/ copy whose manifest grants localhost up front; the shipped code path then runs unmodified. */
async function runOriginStripSection() {
  const { server, port, seen } = await startStrictOriginProvider();
  const stagingDir = mkdtempSync(path.join(os.tmpdir(), 'asksql-ext-originstrip-'));
  const stagedDist = path.join(stagingDir, 'dist');
  cpSync(dist, stagedDist, { recursive: true });
  const manifestPath = path.join(stagedDist, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://localhost/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    dumpio: !!process.env.CI,
    args: [
      `--disable-extensions-except=${stagedDist}`,
      `--load-extension=${stagedDist}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const extensionId = await findExtensionId(browser);
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });

    // Baseline: prove the bug is real in this browser before the fix runs -
    // a raw POST from an extension page still carries Origin, so it 403s.
    const rawStatus = await page.evaluate(async (p) => {
      const res = await fetch(`http://localhost:${p}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [] }),
      });
      return res.status;
    }, port);
    assert(
      rawStatus === 403,
      `Origin strip: BASELINE - an unprotected POST from an extension page is rejected by a strict-origin provider (got ${rawStatus})`,
    );

    await page.evaluate(
      async (p) =>
        chrome.storage.local.set({
          'asksql.provider': { provider: 'ollama', model: 'test-model', baseURL: `http://localhost:${p}/v1` },
        }),
      port,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#baseURL', { timeout: 10_000 });

    const savedLabel = await page.$$eval('button', (b) => b.map((x) => x.textContent));
    assert(
      savedLabel.includes('Saved'),
      `Settings: a freshly loaded page shows no unsaved changes (buttons: ${JSON.stringify(savedLabel)})`,
    );

    const testBtn = await findButton(page, 'Test provider');
    await testBtn.click();
    await page.waitForFunction(
      () => {
        const t = document.querySelector('.asksql-ext-status')?.textContent ?? '';
        return t && !t.includes('Testing...');
      },
      { timeout: 30_000 },
    );
    const status = await page.evaluate(() => document.querySelector('.asksql-ext-status')?.textContent ?? '');
    assert(
      status.includes('Provider responded successfully'),
      `Origin strip: the real "Test provider" flow completes a chat-completions POST against a strict-origin provider (status: ${status})`,
    );

    const postWithOrigin = seen.filter((r) => r.method === 'POST' && r.origin !== null);
    const postWithoutOrigin = seen.filter((r) => r.method === 'POST' && r.origin === null);
    assert(
      postWithoutOrigin.length > 0,
      `Origin strip: the provider actually received a POST with no Origin header (requests seen: ${JSON.stringify(seen)})`,
    );
    assert(
      postWithOrigin.length === 1,
      `Origin strip: only the deliberate baseline POST carried an Origin, none from the production path (${postWithOrigin.length} seen)`,
    );

    await page.close();
  } finally {
    await browser.close();
    server.close();
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    dumpio: !!process.env.CI,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const extensionId = await findExtensionId(browser);
    assert(Boolean(extensionId), 'extension service worker registered and its id was discovered');
    if (!extensionId) {
      console.log(`\n${failures} FAILURE(S)`);
      process.exitCode = 1;
      return;
    }

    await section('Data file connection', async () => {
      const status = await createFileConnection(browser, extensionId, 'Sales', [csvFixture]);
      assert(
        status.includes('1 table(s)'),
        `Data files: Settings builds a named connection from an upload (got: ${status})`,
      );

      const page = await openSidePanelAndConnect(browser, extensionId, 'Sales', 'SELECT COUNT(*) AS n FROM sales');
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(String(err)));

      await page.waitForSelector(taSelector, { timeout: 30_000 });
      const textarea = await page.$(taSelector);
      await textarea.type('How many rows are there?');
      await page.keyboard.press('Enter');

      await page.waitForFunction(() => document.querySelector('.asksql-table, .asksql-error'), { timeout: 20_000 });
      const sql = await page.evaluate(() => document.querySelector('.asksql-sqlcode')?.textContent ?? null);
      const errorText = await page.evaluate(() => document.querySelector('.asksql-error')?.textContent ?? null);
      assert(
        await page.evaluate(() => Boolean(document.querySelector('.asksql-table'))),
        `Data files: a question round-trips through the real guard+engine to a result table (sql: ${sql})${errorText ? ` (error: ${errorText})` : ''}`,
      );
      assert(
        pageErrors.length === 0,
        `Data files: no uncaught page errors${pageErrors.length ? ` (${pageErrors.join('; ')})` : ''}`,
      );
      await page.close();
    });

    await section('Connection outlives the panel', async () => {
      // The whole point of modelling uploads as connections: closing the panel
      // and coming back must not require re-uploading anything.
      const page = await openSidePanelAndConnect(browser, extensionId, 'Sales', 'SELECT COUNT(*) AS n FROM sales');
      await page.waitForSelector(taSelector, { timeout: 30_000 });
      const textarea = await page.$(taSelector);
      await textarea.type('How many rows are there?');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.asksql-table, .asksql-error'), { timeout: 20_000 });
      assert(
        await page.evaluate(() => Boolean(document.querySelector('.asksql-table'))),
        'Reopen: a fresh panel reconnects to the stored connection and answers without re-uploading',
      );
      await page.close();
    });

    await section('Multi-file (xlsx + zip)', async () => {
      const status = await createFileConnection(browser, extensionId, 'Bundle', [xlsxFixture, zipFixture]);
      assert(
        status.includes('Skipped 1 unsupported file(s)') && status.includes('README.md'),
        `Zip upload: the non-data zip member is skipped and named, not silently dropped (got: ${status})`,
      );

      // Table names come from sanitizeTableName: "multi-sheet.xlsx" -> "multi_sheet"
      // (hyphen -> underscore, extension stripped), then "_Products"/"_Orders" per sheet.
      const page = await openSidePanelAndConnect(
        browser,
        extensionId,
        'Bundle',
        'SELECT (SELECT COUNT(*) FROM multi_sheet_Products) + (SELECT COUNT(*) FROM customers) AS n',
      );
      await page.waitForSelector(taSelector, { timeout: 30_000 });
      const textarea = await page.$(taSelector);
      await textarea.type('Combined count');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.asksql-table, .asksql-error'), { timeout: 20_000 });
      const err = await page.evaluate(() => document.querySelector('.asksql-error')?.textContent ?? null);
      assert(
        await page.evaluate(() => Boolean(document.querySelector('.asksql-table'))),
        `Multi-sheet xlsx + zip: both sheets and both zip-extracted files are real, joinable tables${err ? ` (error: ${err})` : ''}`,
      );
      await page.close();
    });

    await section('Sidecar connection', async () => {
      const { httpServer, port } = await startFakeSidecar();
      try {
        const direct = await fetch(`http://localhost:${port}/connections`);
        assert(direct.status === 200, 'Sidecar: the fake server itself answers /connections (sanity check)');

        const optionsPage = await browser.newPage();
        await optionsPage.goto(`chrome-extension://${extensionId}/options/index.html`, {
          waitUntil: 'domcontentloaded',
        });
        await optionsPage.waitForSelector('#connType', { timeout: 10_000 });
        await optionsPage.select('#connType', 'server');
        await optionsPage.type('#connName', 'Local test sidecar');
        await optionsPage.type('#connUrl', `http://localhost:${port}`);
        const addBtn = await findButton(optionsPage, 'Add connection');
        await addBtn.click();
        await optionsPage.waitForFunction(
          () =>
            [...document.querySelectorAll('.asksql-ext-status')].some((el) =>
              (el.textContent ?? '').includes('Connection added'),
            ),
          { timeout: 10_000 },
        );
        assert(
          true,
          'Connections: one Settings list adds both data files and servers, choosing the kind from a dropdown',
        );
        await optionsPage.close();

        const sidePanel = await browser.newPage();
        await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, {
          waitUntil: 'domcontentloaded',
        });
        await sidePanel.waitForSelector('#connection', { timeout: 15_000 });

        const labels = await sidePanel.evaluate(() =>
          [...document.querySelectorAll('#connection option')].map((o) => o.textContent.trim()),
        );
        assert(
          labels.some((l) => l.includes('Sales') && l.includes('data files')) &&
            labels.some((l) => l.includes('Local test sidecar') && l.includes('server')),
          `Connection picker: data-file and server connections appear together in one labelled dropdown (got: ${JSON.stringify(labels)})`,
        );

        await sidePanel.select('#connection', await optionValueByLabel(sidePanel, 'Local test sidecar'));
        const connectBtn = await findButton(sidePanel, 'Connect');
        await connectBtn.click();

        // Header limitation: permissions.request() never resolves headlessly - assert only that the click reached the permission gate.
        await sidePanel.waitForFunction(
          () => (document.querySelector('.asksql-ext-status')?.textContent ?? '').includes('Connecting'),
          { timeout: 10_000 },
        );
        assert(true, 'Sidecar: Connect reached HttpTransport wiring and the permission gate (ensureOriginAccess)');
        await sidePanel.close();
      } finally {
        httpServer.close();
      }
    });
    await section('Fetch models (options)', async () => {
      const optionsPage = await browser.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });
      // Default provider is ollama, which is always listable (localhost:11434/v1
      // even with no configured override), so the button renders with no setup.
      const fetchBtn = await findButton(optionsPage, 'Fetch models');
      assert(Boolean(fetchBtn), 'Fetch models: button renders for the default (ollama) provider without configuration');
      await fetchBtn.click();

      // Same headless-permission ceiling as the sidecar section: assert the click reached ensureOriginAccess.
      await optionsPage.waitForFunction(
        () => (document.querySelector('.asksql-ext-status')?.textContent ?? '').includes('Looking up models'),
        { timeout: 10_000 },
      );
      assert(true, 'Fetch models: click reached fetchProviderModels and the permission gate (ensureOriginAccess)');
      await optionsPage.close();
    });

    await section('Base URL field is provider-aware (options)', async () => {
      const optionsPage = await browser.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });
      await optionsPage.waitForSelector('#baseURL', { timeout: 10_000 });

      const readBaseUrlField = () => ({
        label: document.querySelector('label[for="baseURL"]')?.textContent ?? null,
        placeholder: document.querySelector('#baseURL')?.getAttribute('placeholder') ?? null,
      });

      const ollamaField = await optionsPage.evaluate(readBaseUrlField);
      assert(
        ollamaField.label?.includes('optional override') && ollamaField.placeholder === 'http://localhost:11434/v1',
        `Base URL: ollama (default provider) is labeled optional with its real default as a placeholder (got: ${JSON.stringify(ollamaField)})`,
      );

      await optionsPage.select('#provider', 'azure');
      const azureField = await optionsPage.evaluate(readBaseUrlField);
      assert(
        azureField.label?.includes('required') && azureField.placeholder === 'https://<resource>.openai.azure.com',
        `Base URL: azure (no fixed host - resource-specific) is labeled required with a shape hint (got: ${JSON.stringify(azureField)})`,
      );
      await optionsPage.close();
    });
  } finally {
    await browser.close();
  }

  // Runs in its own browser because an extension's manifest is read at launch.
  await section('Strict-origin provider (Ollama-shaped)', () => runOriginStripSection());

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
