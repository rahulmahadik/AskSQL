/** Builds the store-submission zip from dist/, stripping manifest `key` from a staged copy only: `key` keeps the unpacked build's id stable for local dev, but the store assigns its own id and rejects a manifest that has one. */
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(here, 'dist');
const outZip = path.join(here, 'asksql-browser-extension.zip');

if (!existsSync(dist)) {
  console.error(`${dist} does not exist - run "npm run build" first.`);
  process.exit(1);
}

const staging = mkdtempSync(path.join(os.tmpdir(), 'asksql-ext-package-'));
try {
  cpSync(dist, staging, { recursive: true });

  const manifestPath = path.join(staging, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!('key' in manifest)) {
    throw new Error('dist/manifest.json has no "key" field - build output looks unexpected, refusing to package.');
  }
  delete manifest.key;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  rmSync(outZip, { force: true });
  execFileSync('zip', ['-rq', outZip, '.'], { cwd: staging, stdio: 'inherit' });
  console.log(`Wrote ${path.relative(here, outZip)} (manifest "key" stripped for store submission).`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
