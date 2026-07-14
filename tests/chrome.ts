/**
 * Cross-platform Chrome/Chromium resolution for the browser tests. Works on
 * macOS, Linux, and Windows: honors CHROME_PATH / PUPPETEER_EXECUTABLE_PATH
 * first, then probes the usual install locations per platform. Returns null
 * when no browser is found (the tests then skip, never fail).
 *
 * The PRODUCT runs in any modern browser (standard Web Worker / OPFS / File
 * APIs); Chrome here is only the test *driver*.
 */
import { existsSync } from 'node:fs';
import { platform } from 'node:process';

const CANDIDATES: Record<string, string[]> = {
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
    `${process.env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

let cached: string | null | undefined;

/** Resolve a Chrome/Chromium/Edge executable, or null if none is found. */
export function resolveChrome(): string | null {
  if (cached !== undefined) return cached;
  const fromEnv = process.env['CHROME_PATH'] ?? process.env['PUPPETEER_EXECUTABLE_PATH'];
  if (fromEnv && existsSync(fromEnv)) return (cached = fromEnv);
  for (const p of CANDIDATES[platform] ?? []) {
    if (existsSync(p)) return (cached = p);
  }
  return (cached = null);
}
