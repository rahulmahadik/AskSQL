/**
 * Browser (IIFE) entry - the build behind the `<script>` tag.
 *
 * esbuild bundles this (with React and react-dom included) into
 * `dist/asksql-widget.js`, so a plain HTML page can do:
 *
 *   <script src="https://unpkg.com/@asksql/widget"></script>
 *   <script>AskSQL.mount({ target: '#chat', serverUrl: '/asksql' })</script>
 *
 * The ESM entry (`src/index.ts`) stays the package's `main`/`module` for
 * bundler users; this file only adds the global.
 */

import AskSQL from './index.js';

declare global {
  interface Window {
    AskSQL?: typeof AskSQL;
  }
}

if (typeof window !== 'undefined') window.AskSQL = AskSQL;

export default AskSQL;
