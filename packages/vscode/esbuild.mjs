/**
 * One bundle: the extension host. The panel is a WebviewView served from plain
 * assets in media/, so there is no second bundle to build.
 *
 * `vscode` is injected by the editor at runtime and must stay external. The
 * native/optional deps below are deliberately NOT shipped - AskSQL uses pure-JS
 * drivers (pg, mysql2) and Node's built-in sqlite, so nothing needs an
 * Electron ABI rebuild. Marking them external stops esbuild resolving them.
 */
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--production');

const nativeOptional = ['pg-native', 'cloudflare:sockets', 'better-sqlite3'];

const host = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', ...nativeOptional],
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(host);
  await ctx.watch();
  console.log('watching...');
} else {
  await esbuild.build(host);
  console.log('built dist/extension.js');
}
