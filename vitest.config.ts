import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@asksql/core': pkg('core'),
      '@asksql/duckdb': pkg('duckdb'),
      '@asksql/sqlite': pkg('sqlite'),
      '@asksql/postgres': pkg('postgres'),
      '@asksql/mysql': pkg('mysql'),
      '@asksql/server/express': fileURLToPath(new URL('./packages/server/src/express.ts', import.meta.url)),
      '@asksql/server': pkg('server'),
      '@asksql/react': pkg('react'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    environment: 'node',
  },
});
