import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Only the vscode package imports 'vscode'; a test-only stand-in keeps its
      // logic runnable outside the extension host.
      vscode: fileURLToPath(new URL('./packages/vscode/test/vscode-mock.ts', import.meta.url)),
      '@asksql/core/mongo': fileURLToPath(new URL('./packages/core/src/mongo/index.ts', import.meta.url)),
      '@asksql/core': pkg('core'),
      // Must precede the bare '@asksql/duckdb' entry: aliases match in order,
      // and the bare one would rewrite this subpath to index.ts/browser.
      '@asksql/duckdb/browser': fileURLToPath(new URL('./packages/duckdb/src/browser.ts', import.meta.url)),
      '@asksql/duckdb': pkg('duckdb'),
      '@asksql/sqlite': pkg('sqlite'),
      '@asksql/postgres': pkg('postgres'),
      '@asksql/mysql': pkg('mysql'),
      '@asksql/oracle': pkg('oracle'),
      '@asksql/mongodb': pkg('mongodb'),
      '@asksql/server/express': fileURLToPath(new URL('./packages/server/src/express.ts', import.meta.url)),
      '@asksql/server': pkg('server'),
      '@asksql/react': pkg('react'),
      '@asksql/widget': pkg('widget'),
      '@asksql/mcp': pkg('mcp'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      // The coverage floor gates the reusable LIBRARY - the engine, connectors, server,
      // and MCP tools. The VS Code extension and React UI packages are host/browser
      // integration layers (webview messaging, commands, secrets, tree rendering; React
      // components + hooks) validated by their own suites and live rendering, not this
      // branch floor. duckdb/browser.ts and widget/* are the duckdb-wasm/browser builds
      // (need a browser + WASM). The browser extension's React entry points (sidepanel/
      // options, DOM-rendering) get the same treatment, validated by its real-browser
      // smoke suite instead; everything else in that package - including the service
      // worker - is plain TS a chrome.* mock can unit-test directly, so it stays in the
      // floor.
      exclude: [
        '**/*.d.ts',
        '**/index.ts',
        'packages/widget/src/**',
        'packages/duckdb/src/browser.ts',
        'packages/vscode/src/**',
        'packages/react/src/**',
        // Process entry point: one call into main() plus exit-code plumbing.
        'packages/server/src/bin.ts',
        'packages/browser-extension/src/sidepanel/**',
        'packages/browser-extension/src/options/**',
      ],
      // Floors below the current numbers, so a coverage regression fails `pnpm coverage`.
      thresholds: { statements: 92, branches: 85, functions: 94, lines: 94 },
    },
  },
});
