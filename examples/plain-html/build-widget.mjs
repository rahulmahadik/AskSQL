/**
 * Bundle @asksql/widget into a single self-contained IIFE for <script> use.
 * React + ReactDOM + the AskSQL UI are all inlined so a plain HTML page can
 * embed the widget with one tag and an AskSQL.mount(...) call.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../../packages/widget/src/index.ts', import.meta.url));
const outfile = fileURLToPath(new URL('./asksql-widget.js', import.meta.url));

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  globalName: 'AskSQL',
  outfile,
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
console.log('built', outfile);
