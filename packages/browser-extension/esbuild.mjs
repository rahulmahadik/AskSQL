/** Multi-entry MV3 build: background, side panel, and options each get their own bundle. DuckDB-WASM worker/wasm assets are copied verbatim from node_modules and self-hosted via chrome.runtime.getURL - MV3 forbids remotely hosted code. */
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--production');

const common = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome116',
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['src/background.ts'], outfile: 'dist/background.js' },
  // Split so the guard's SQL parser loads only when a file connection is opened.
  {
    ...common,
    entryPoints: { 'sidepanel/main': 'src/sidepanel/main.tsx', 'options/main': 'src/options/main.tsx' },
    outdir: 'dist',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
  },
];

function copyStatic() {
  mkdirSync(dist, { recursive: true });
  cpSync(path.join(here, 'manifest.json'), path.join(dist, 'manifest.json'));
  cpSync(path.join(here, 'public'), dist, { recursive: true });
  cpSync(path.join(here, 'src/sidepanel/index.html'), path.join(dist, 'sidepanel/index.html'));
  cpSync(path.join(here, 'src/options/index.html'), path.join(dist, 'options/index.html'));

  // Self-hosted DuckDB-WASM bundles: copied verbatim, referenced at runtime via
  // chrome.runtime.getURL('duckdb-wasm/<file>') - never fetched from a CDN.
  const duckdbDist = path.join(here, 'node_modules/@duckdb/duckdb-wasm/dist');
  const duckdbOut = path.join(dist, 'duckdb-wasm');
  mkdirSync(duckdbOut, { recursive: true });
  const assets = ['duckdb-mvp.wasm', 'duckdb-browser-mvp.worker.js', 'duckdb-eh.wasm', 'duckdb-browser-eh.worker.js'];
  for (const asset of assets) {
    const src = path.join(duckdbDist, asset);
    if (!existsSync(src)) {
      throw new Error(`Missing DuckDB-WASM asset: ${src}. Run "pnpm install" first.`);
    }
    cpSync(src, path.join(duckdbOut, asset));
  }

  // public/duckdb-extensions is populated by scripts/fetch-duckdb-extensions.mjs
  // (build-time only, never at runtime) - see that script for why. A production
  // build with it missing would silently ship xlsx support that fails for every
  // user, so that combination is a hard build failure, not a warning.
  const extSrc = path.join(here, 'public/duckdb-extensions');
  const hasExtensionFiles = existsSync(extSrc) && cpSyncIfNonEmpty(extSrc, path.join(dist, 'duckdb-extensions'));
  if (prod && !hasExtensionFiles) {
    throw new Error(
      'public/duckdb-extensions is empty - run "node scripts/fetch-duckdb-extensions.mjs" (needs a local ' +
        'Chrome/Chromium/Edge) before a production build, or xlsx uploads will fail for every user.',
    );
  }
}

// public/duckdb-extensions always has a committed .gitkeep even with no real
// extension fetched yet, so presence has to be checked by content, not existence.
function cpSyncIfNonEmpty(src, dest) {
  cpSync(src, dest, { recursive: true });
  return readdirSync(dest, { recursive: true }).some((f) => f.toString().endsWith('.duckdb_extension.wasm'));
}

if (watch) {
  copyStatic();
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching...');
} else {
  // A production build sets sourcemap: false, which never OVERWRITES maps a previous watch build
  // left behind - and package-zip.mjs ships everything in dist (34+ MB of unminified source).
  rmSync(dist, { recursive: true, force: true });
  copyStatic();
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log('built dist/{background.js,sidepanel/main.js,options/main.js}');
}
