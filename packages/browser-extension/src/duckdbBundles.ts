/**
 * DuckDB-WASM assets, bundled at build time rather than fetched from a CDN
 * (Manifest V3 forbids remotely hosted code). Shared by the options page,
 * which builds a data-file connection, and the side panel, which opens one.
 */
import type { DuckDbBundles } from '@asksql/duckdb/browser';

export const BUNDLES: DuckDbBundles = {
  mvp: {
    mainModule: chrome.runtime.getURL('duckdb-wasm/duckdb-mvp.wasm'),
    mainWorker: chrome.runtime.getURL('duckdb-wasm/duckdb-browser-mvp.worker.js'),
  },
  eh: {
    mainModule: chrome.runtime.getURL('duckdb-wasm/duckdb-eh.wasm'),
    mainWorker: chrome.runtime.getURL('duckdb-wasm/duckdb-browser-eh.worker.js'),
  },
};

export const XLSX_EXTENSION_REPOSITORY = chrome.runtime.getURL('duckdb-extensions');
