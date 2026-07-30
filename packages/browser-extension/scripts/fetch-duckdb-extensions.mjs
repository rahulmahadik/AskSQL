/** Build-time only: lays the DuckDB `excel` extension out under public/duckdb-extensions/ in the $duckdb_version/$platform/ layout LOAD expects (MV3 forbids fetching WASM from extensions.duckdb.org at runtime). The engine version is not derivable from the npm semver, so the URL is discovered by running INSTALL excel in headless Chrome and capturing the request. */
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DUCKDB_DIST = path.join(here, 'node_modules/@duckdb/duckdb-wasm/dist');
const OUT_DIR = path.join(here, 'public/duckdb-extensions');

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

function resolveChrome() {
  const fromEnv = process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of CHROME_CANDIDATES[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function discoverExtensionUrls(chromePath) {
  const probeEntry = `
    import * as duckdb from '@duckdb/duckdb-wasm';
    (async () => {
      for (const platform of ['eh', 'mvp']) {
        try {
          const bundle = { mainModule: '/duckdb-' + platform + '.wasm', mainWorker: '/duckdb-browser-' + platform + '.worker.js' };
          const worker = new Worker(bundle.mainWorker);
          const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
          const db = new duckdb.AsyncDuckDB(logger, worker);
          await db.instantiate(bundle.mainModule);
          const conn = await db.connect();
          await conn.query('INSTALL excel; LOAD excel;');
          await conn.close();
          await db.terminate();
        } catch {
          /* the fetch is recorded before the load itself needs to succeed */
        }
      }
      window.__done = true;
    })();
  `;
  const bundled = await esbuild.build({
    stdin: { contents: probeEntry, resolveDir: here, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  const bundleJs = bundled.outputFiles[0].text;

  const server = http.createServer((req, res) => {
    if (req.url === '/probe.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(bundleJs);
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script type="module" src="/probe.js"></script>');
      return;
    }
    try {
      const body = readFileSync(path.join(DUCKDB_DIST, decodeURIComponent(req.url ?? '')));
      const ct = req.url?.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    // CDP-level capture, not an in-page fetch monkeypatch: the actual LOAD
    // request is issued from inside the DuckDB Web Worker, which an in-page
    // `window.fetch` override never sees.
    const seen = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('duckdb.org') && url.includes('excel')) seen.push(url);
    });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => window.__done === true, { timeout: 30_000 });
    return seen;
  } finally {
    await browser.close();
    server.close();
  }
}

async function main() {
  const chromePath = resolveChrome();
  if (!chromePath) {
    console.warn(
      'fetch-duckdb-extensions: no Chrome/Chromium/Edge found - skipping. ' +
        'xlsx uploads will show a clear error in the built extension instead of failing silently.',
    );
    return;
  }

  // A cold headless-Chrome launch on a busy runner can miss the 30s discovery window; retry once - a second consecutive timeout still fails the build.
  let discovered = [];
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      discovered = await discoverExtensionUrls(chromePath);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`fetch-duckdb-extensions: discovery attempt ${attempt} failed (${err.message}), retrying...`);
    }
  }
  if (lastErr) throw lastErr;

  const urls = [...new Set(discovered)];
  if (urls.length === 0) {
    console.warn('fetch-duckdb-extensions: could not discover any extension URLs - skipping xlsx bundling.');
    return;
  }

  for (const url of urls) {
    const relative = new URL(url).pathname.replace(/^\//, '');
    const outPath = path.join(OUT_DIR, relative);
    mkdirSync(path.dirname(outPath), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`fetch-duckdb-extensions: ${url} responded ${res.status} - skipping.`);
      continue;
    }
    writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
    console.log(`fetch-duckdb-extensions: wrote ${relative}`);
  }
}

await main();
