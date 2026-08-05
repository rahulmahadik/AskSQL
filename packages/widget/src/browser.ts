/**
 * Browser (IIFE) entry - the build behind the `<script>` tag.
 *
 * esbuild bundles this with React into `dist/asksql-widget.js` and it adds the
 * `AskSQL` global; `src/index.ts` stays the ESM entry for bundler users.
 */

import AskSQL from './index.js';

declare global {
  interface Window {
    AskSQL?: typeof AskSQL;
  }
}

if (typeof window !== 'undefined') window.AskSQL = AskSQL;

export default AskSQL;
