/**
 * Live settings-toggle suite: flips each user-facing engine toggle in a real
 * browser and asserts the behavioral difference, which the unit suite cannot
 * see. Run: node test/e2e-settings.mjs <chrome-for-testing>
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dist = path.join(root, 'dist');
const csvFixture = path.join(root, '../../examples/browser-duckdb/sales.csv');
const ta = 'textarea[aria-label="Ask a question about your data"]';
const CHROME = process.argv[2];
if (!CHROME || !existsSync(CHROME)) {
  console.error('Usage: node test/e2e-settings.mjs <path-to-chrome-for-testing>');
  process.exit(1);
}

let failures = 0;
const ok = (c, msg) => {
  console.log((c ? 'PASS: ' : 'FAIL: ') + msg);
  if (!c) failures++;
};
const section = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name} - ${err instanceof Error ? err.message : String(err)}`);
  }
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox'],
  defaultViewport: { width: 480, height: 800 },
});

const buttons = (p) => p.$$eval('button', (bs) => bs.map((b) => b.textContent.trim()));
const click = async (p, label) => {
  const idx = (await buttons(p)).indexOf(label);
  if (idx === -1) throw new Error(`no button "${label}" (have: ${(await buttons(p)).join(', ')})`);
  await (await p.$$('button'))[idx].click();
};

/** Opens the side panel with the given engine settings and an injected model, connected to the prepared file connection. */
async function openPanel(extensionId, engineSettings, modelScript) {
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(modelScript);
  await p.goto(`chrome-extension://${extensionId}/sidepanel/index.html`, { waitUntil: 'domcontentloaded' });
  await p.evaluate(async (settings) => {
    const got = await chrome.storage.local.get(['asksql.engine']);
    await chrome.storage.local.set({ 'asksql.engine': { ...got['asksql.engine'], ...settings } });
  }, engineSettings);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#connection', { timeout: 20_000 });
  await click(p, 'Connect');
  await p.waitForSelector(ta, { timeout: 90_000 });
  return p;
}

async function askAndSettle(p, question, doneSelector) {
  await (await p.$(ta)).type(question);
  await p.keyboard.press('Enter');
  await p.waitForFunction((sel) => document.querySelector(sel), { timeout: 60_000 }, doneSelector);
}

try {
  let extensionId = null;
  for (let i = 0; i < 40 && !extensionId; i++) {
    const sw = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
    if (sw) extensionId = new URL(sw.url()).host;
    else await new Promise((r) => setTimeout(r, 250));
  }

  // One file connection, shared by every section.
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });
  await options.waitForSelector('#connType', { timeout: 10_000 });
  await options.select('#connType', 'files');
  await options.type('#connName', 'Sales');
  await (await options.$('#connFiles')).uploadFile(csvFixture);
  await new Promise((r) => setTimeout(r, 400));
  await click(options, 'Add connection');
  await options.waitForFunction(() => /Added "Sales"/.test(document.body.innerText), { timeout: 90_000 });
  await options.close();

  const plainModel = () => {
    window.__asksqlModel = async () => '```sql\nSELECT COUNT(*) AS n FROM sales\n```';
  };

  await section('requireApproval', async () => {
    const p = await openPanel(extensionId, { requireApproval: true }, plainModel);
    try {
      await askAndSettle(p, 'How many rows?', '.asksql-sqlcode');
      ok(!(await p.$('.asksql-table')), 'requireApproval=true: the query does NOT auto-run');
      ok((await buttons(p)).includes('Run query'), 'a Run query button gates execution');
      await click(p, 'Run query');
      await p.waitForFunction(() => document.querySelector('.asksql-table'), { timeout: 30_000 });
      ok(true, 'clicking Run query executes and shows the result');
    } finally {
      await p.close();
    }

    const p2 = await openPanel(extensionId, { requireApproval: false }, plainModel);
    try {
      await askAndSettle(p2, 'How many rows?', '.asksql-table');
      ok(true, 'requireApproval=false: the same question auto-runs to a result');
    } finally {
      await p2.close();
    }
  });

  await section('sqlDisplayPlacement', async () => {
    const order = async (placement) => {
      const p = await openPanel(extensionId, { requireApproval: false, sqlDisplayPlacement: placement }, plainModel);
      await askAndSettle(p, 'How many rows?', '.asksql-table');
      try {
        return await p.evaluate(() => {
          const sql = document.querySelector('.asksql-sqlblock');
          const table = document.querySelector('.asksql-table');
          if (!sql || !table) return null;
          return sql.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING ? 'sql-first' : 'table-first';
        });
      } finally {
        await p.close();
      }
    };
    ok((await order('before')) === 'sql-first', "placement 'before': SQL renders above the result");
    ok((await order('after')) === 'table-first', "placement 'after': SQL renders below the result");
  });

  await section('customInstructions', async () => {
    const capture = () => {
      window.__captured = [];
      window.__asksqlModel = async (req) => {
        window.__captured.push(req.system);
        return '```sql\nSELECT COUNT(*) AS n FROM sales\n```';
      };
    };
    const p = await openPanel(
      extensionId,
      { requireApproval: false, customInstructions: 'Always alias aggregate columns as friendly_names.' },
      capture,
    );
    await askAndSettle(p, 'How many rows?', '.asksql-table');
    let systems;
    try {
      systems = await p.evaluate(() => window.__captured);
      ok(
        systems.some((s) => s.includes('Additional instructions') && s.includes('friendly_names')),
        'custom instructions reach the system prompt under "Additional instructions"',
      );
      ok(
        systems.some((s) => /read-only|SELECT/i.test(s)),
        'the built-in read-only rules are still present (custom text is additive)',
      );
    } finally {
      await p.close();
    }
  });

  await section('answerSchemaQuestions', async () => {
    const twoPhase = () => {
      let calls = 0;
      window.__asksqlModel = async () => {
        calls += 1;
        if (calls === 1) return 'IMPOSSIBLE: that is a question about the schema, not the data.';
        return 'The **sales** table holds one row per sale with region and amount columns.';
      };
    };
    const p = await openPanel(extensionId, { requireApproval: false, answerSchemaQuestions: true }, twoPhase);
    try {
      await (await p.$(ta)).type('What tables are there?');
      await p.keyboard.press('Enter');
      await p.waitForFunction(() => document.querySelector('.asksql-explain, .asksql-error'), { timeout: 60_000 });
      const explain = await p.evaluate(() => document.querySelector('.asksql-explain')?.textContent ?? null);
      ok(
        Boolean(explain && explain.includes('sales')),
        `schema question answered in prose instead of erroring (got: ${explain ?? (await p.evaluate(() => document.querySelector('.asksql-error')?.textContent))})`,
      );
    } finally {
      await p.close();
    }
  });
} finally {
  await browser.close();
}
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
