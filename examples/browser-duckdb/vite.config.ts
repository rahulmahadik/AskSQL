import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // DuckDB-WASM ships large prebuilt assets; don't try to inline them.
  build: { sourcemap: false, assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  worker: { format: 'es' },
});
