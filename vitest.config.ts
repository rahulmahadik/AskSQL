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
      // components + hooks) validated by their own suites (218 + 86 tests) and live
      // rendering, not this branch floor. duckdb/browser.ts and widget/* are the
      // duckdb-wasm/browser builds (need a browser + WASM).
      exclude: [
        '**/*.d.ts',
        '**/index.ts',
        'packages/widget/src/**',
        'packages/duckdb/src/browser.ts',
        'packages/vscode/src/**',
        'packages/react/src/**',
      ],
      // Floors below the current numbers, so a coverage regression fails `pnpm coverage`.
      thresholds: { statements: 92, branches: 85, functions: 94, lines: 94 },
    },
  },
});
