/**
 * Regenerates the store-listing screenshots from the CURRENT UI, at the
 * 1280x800 size the Chrome Web Store and Edge Add-ons listings expect.
 * Usage: node test/screenshot.mjs <chrome-for-testing> <outDir>
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dist = path.join(root, 'dist');
const csvFixture = path.join(root, '../../examples/browser-duckdb/sales.csv');
const [CHROME, outDirArg] = process.argv.slice(2);
const outDir = outDirArg ?? path.join(root, 'images');
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox'],
  defaultViewport: { width: 1280, height: 800 },
});

let extensionId;
for (let i = 0; i < 40 && !extensionId; i++) {
  const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  if (sw) extensionId = new URL(sw.url()).host;
  else await new Promise((r) => setTimeout(r, 250));
}

const shot = (page, name) => page.screenshot({ path: path.join(outDir, name) });
const buttons = (page) => page.$$eval('button', (bs) => bs.map((b) => b.textContent.trim()));
const click = async (page, label) => {
  const idx = (await buttons(page)).indexOf(label);
  if (idx === -1) throw new Error(`no button "${label}"`);
  await (await page.$$('button'))[idx].click();
};

// --- Settings: provider + engine, then a data-file connection + database form ---
const options = await browser.newPage();
await options.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });
await options.evaluate(async () =>
  chrome.storage.local.set({ 'asksql.provider': { provider: 'ollama', model: 'qwen2.5-coder:14b' } }),
);
await options.reload({ waitUntil: 'domcontentloaded' });
await options.waitForSelector('#provider');
await shot(options, 'settings.png');

await options.select('#connType', 'files');
await options.type('#connName', 'Q1 sales');
await (await options.$('#connFiles')).uploadFile(csvFixture);
await new Promise((r) => setTimeout(r, 400));
await click(options, 'Add connection');
await options.waitForFunction(() => /Added "Q1 sales"/.test(document.body.innerText), { timeout: 90_000 });
await options.select('#connType', 'database');
await options.waitForSelector('#dbEngine');
const conn = await options.$('.asksql-ext-connection-row');
await conn.scrollIntoViewIfNeeded?.();
await options.evaluate(() => document.querySelector('.asksql-ext-connection-row')?.scrollIntoView({ block: 'start' }));
await shot(options, 'connections.png');
await options.close();

// --- Side panel: connect, ask, result; then the schema tree ---
const panel = await browser.newPage();
await panel.evaluateOnNewDocument(() => {
  window.__asksqlModel = async () => '```sql\nSELECT region, SUM(amount) AS total_amount FROM sales GROUP BY region ORDER BY total_amount DESC\n```';
});
await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: 'domcontentloaded' });
await panel.waitForSelector('#connection', { timeout: 20_000 });
await click(panel, 'Connect');
const ta = 'textarea[aria-label="Ask a question about your data"]';
await panel.waitForSelector(ta, { timeout: 90_000 });
await (await panel.$(ta)).type('Which region has the highest total amount?');
await panel.keyboard.press('Enter');
await panel.waitForFunction(() => document.querySelector('.asksql-table'), { timeout: 60_000 });
await shot(panel, 'chat-result.png');

await click(panel, 'Schema');
await panel.waitForSelector('.asksql-schema-toggle', { timeout: 30_000 });
await (await panel.$('.asksql-schema-toggle')).click();
await panel.waitForFunction(() => document.querySelectorAll('.asksql-schema-col').length > 0, { timeout: 10_000 });
await shot(panel, 'schema.png');
await panel.close();

await browser.close();
console.log(`wrote settings.png, connections.png, chat-result.png, schema.png to ${outDir}`);
