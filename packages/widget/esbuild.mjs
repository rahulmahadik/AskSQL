/**
 * Browser bundle: the standalone `<script>`-tag build.
 *
 * `tsc -b` already emits the ESM entry (dist/index.js) for bundler users. This
 * adds a single self-contained IIFE (dist/asksql-widget.js) with React and
 * react-dom bundled in, so a plain HTML page needs nothing but the one script.
 * It exposes `window.AskSQL` via src/browser.ts. `unpkg`/`jsdelivr` in
 * package.json point CDNs at this file.
 */
import * as esbuild from 'esbuild';

const prod = !process.argv.includes('--dev');

await esbuild.build({
  entryPoints: ['src/browser.ts'],
  outfile: 'dist/asksql-widget.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: true,
  minify: prod,
  logLevel: 'info',
});
console.log('built dist/asksql-widget.js');
