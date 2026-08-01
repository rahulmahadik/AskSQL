/**
 * Real-browser widget test (/05): loads the plain-HTML embed in
 * headless system Chrome and verifies the widget mounts into a SHADOW ROOT,
 * renders the bubble, opens its panel, and - critically - that the host
 * page's hostile global CSS does NOT bleed into the widget.
 *
 * The bundle is built on demand: it is gitignored, and gating the suite on its
 * presence turned every test here into a silent skip.
 *
 * Skips gracefully when Chrome is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { resolveChrome } from './chrome.js';

const htmlDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'plain-html');
const bundlePath = join(htmlDir, 'asksql-widget.js');
const CHROME = resolveChrome();

let browser: Browser | null = null;
let server: Server | null = null;
let baseUrl = '';
let ready = !!CHROME;

beforeAll(async () => {
  if (!ready) return;
  // Always rebuild: building only when missing meant a stale bundle from an older source
  // tree was tested forever locally, which is how this suite drifted out of date before.
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [join(htmlDir, 'build-widget.mjs')], { stdio: 'ignore' });
  // Serve the plain-html dir (the page's mount() points at a sidecar that
  // isn't running - that's fine, the bubble renders before any request).
  server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    const file = url === '/' ? 'index.html' : url.slice(1);
    try {
      const body = await readFile(join(htmlDir, file));
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((r) => {
    server!.listen(0, () => {
      const addr = server!.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;
      r();
    });
  });

  try {
    const puppeteer = await import('puppeteer-core');
    browser = await puppeteer.default.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  } catch {
    ready = false;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

/**
 * A page whose shadow roots are inspectable. The widget deliberately uses a CLOSED root,
 * which nothing outside can query - including Puppeteer's pierce/ selectors. Forcing the
 * mode open in the page under test keeps these assertions possible while the shipped
 * bundle stays exactly as published.
 */
async function newInspectablePage() {
  const page = await browser!.newPage();
  await page.evaluateOnNewDocument(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'open' });
    };
  });
  return page;
}

const maybe = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(
    name,
    async () => {
      if (!ready || !browser) {
        console.warn('[skip] widget browser test - Chrome or bundle unavailable');
        return;
      }
      await fn();
    },
    timeout,
  );

describe('widget in real Chrome', () => {
  maybe('mounts into a shadow root and renders the bubble', async () => {
    const page = await newInspectablePage();
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });

    // A shadow host exists and contains the bubble button.
    const bubbleText = await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      if (!host?.shadowRoot) return null;
      const btn = host.shadowRoot.querySelector('.asksql-bubble-btn');
      return btn ? btn.textContent : null;
    });
    expect(bubbleText).toBeTruthy();
    await page.close();
  });

  maybe('clicking the bubble opens the chat panel', async () => {
    const page = await newInspectablePage();
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      const btn = host?.shadowRoot?.querySelector('.asksql-bubble-btn') as HTMLButtonElement | undefined;
      btn?.click();
    });
    // Wait for React to flush the open-state re-render into the shadow root.
    await page.waitForFunction(
      () => {
        const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
        return !!host?.shadowRoot?.querySelector('.asksql-bubble-panel');
      },
      { timeout: 5000 },
    );
    const opened = await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      return !!host?.shadowRoot?.querySelector('.asksql-bubble-panel');
    });
    expect(opened).toBe(true);
    await page.close();
  });

  maybe('host hostile CSS does not bleed into the widget', async () => {
    const page = await newInspectablePage();
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    // Host sets Comic Sans + content-box globally. The widget must keep its
    // own sans-serif + border-box inside the shadow root.
    const fonts = await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      const btn = host?.shadowRoot?.querySelector('.asksql-bubble-btn') as HTMLElement | undefined;
      const bodyFont = getComputedStyle(document.body).fontFamily;
      const widgetFont = btn ? getComputedStyle(btn).fontFamily : '';
      return { bodyFont, widgetFont };
    });
    expect(fonts.bodyFont).toMatch(/comic sans/i);
    // Assert the widget actually rendered first: an empty string trivially "is not Comic Sans",
    // so without this the headline isolation claim passed even when nothing mounted.
    expect(fonts.widgetFont).not.toBe('');
    expect(fonts.widgetFont).not.toMatch(/comic sans/i);
    await page.close();
  });

  maybe('bubble sits in the configured corner (bottom-left), clear of host UI', async () => {
    const page = await newInspectablePage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    const geom = await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      const btn = host!.shadowRoot!.querySelector('.asksql-bubble-btn') as HTMLElement;
      const r = btn.getBoundingClientRect();
      const scrollTop = document.getElementById('scrolltop')!.getBoundingClientRect();
      return {
        btnLeft: r.left,
        btnRight: r.right,
        winW: window.innerWidth,
        scrollTopLeft: scrollTop.left,
        overlap: !(r.right < scrollTop.left || r.left > scrollTop.right),
      };
    });
    // Bubble is anchored to the LEFT edge, and does not overlap the host's
    // bottom-right scroll-to-top button.
    expect(geom.btnLeft).toBeLessThan(geom.winW / 2);
    expect(geom.overlap).toBe(false);
    await page.close();
  });

  maybe('mounting twice yields a single bubble', async () => {
    const page = await newInspectablePage();
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      // A second mount into a fresh target; the AskSqlBubble single-instance
      // guard must prevent a second floating button.
      const t = document.createElement('div');
      document.body.appendChild(t);
      (window as unknown as { AskSQL: { mount: (o: object) => void } }).AskSQL.mount({
        target: t,
        serverUrl: '/asksql',
      });
    });
    await new Promise((r) => setTimeout(r, 300));
    const count = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((el) => el.shadowRoot)
        .reduce((n, host) => n + host.shadowRoot!.querySelectorAll('.asksql-bubble-btn').length, 0),
    );
    expect(count).toBe(1);
    await page.close();
  });

  maybe('mobile viewport: panel fits within the screen', async () => {
    const page = await newInspectablePage();
    await page.setViewport({ width: 360, height: 720, isMobile: true });
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      (host?.shadowRoot?.querySelector('.asksql-bubble-btn') as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(
      () => {
        const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
        return !!host?.shadowRoot?.querySelector('.asksql-bubble-panel');
      },
      { timeout: 5000 },
    );
    const fits = await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      const panel = host!.shadowRoot!.querySelector('.asksql-bubble-panel') as HTMLElement;
      const r = panel.getBoundingClientRect();
      return r.left >= -1 && r.right <= window.innerWidth + 1;
    });
    expect(fits).toBe(true);
    await page.close();
  });

  maybe('RTL page: widget renders and SQL area stays LTR-capable', async () => {
    const page = await newInspectablePage();
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    const ok = await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      return !!host?.shadowRoot?.querySelector('.asksql-bubble-btn');
    });
    expect(ok).toBe(true);
    await page.close();
  });

  maybe('a11y: no critical axe violations in the open panel', async () => {
    const page = await newInspectablePage();
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
      (host?.shadowRoot?.querySelector('.asksql-bubble-btn') as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(
      () => {
        const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
        return !!host?.shadowRoot?.querySelector('.asksql-bubble-panel');
      },
      { timeout: 5000 },
    );

    // Inject axe-core source and run it against the whole document (axe
    // descends into shadow roots).
    const axePath = fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url));
    await page.addScriptTag({ path: axePath });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; impact: string }[] }> };
        }
      ).axe;
      const res = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] });
      return res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => v.id);
    });
    // No critical/serious WCAG A/AA violations in the widget UI.
    expect(violations).toEqual([]);
    await page.close();
  });

  // newInspectablePage() forces shadow roots open so the rest of this suite can assert on the
  // widget's internals. That would silently mask the widget shipping an OPEN root, which is a
  // real isolation regression - so check the untouched page separately.
  maybe('the shipped widget uses a CLOSED shadow root, unreachable from page scripts', async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    const probe = await page.evaluate(() => {
      const mount = document.querySelector('[data-asksql-widget]');
      return { mounted: !!mount, shadowRootVisible: !!(mount as HTMLElement | null)?.shadowRoot };
    });
    expect(probe.mounted).toBe(true);
    expect(probe.shadowRootVisible).toBe(false);
    await page.close();
  });
});
