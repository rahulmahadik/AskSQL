import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock, uninstallChromeMock } from './chromeMock.js';

describe('duckdbBundles', () => {
  beforeEach(() => {
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('points every DuckDB asset at a bundled extension URL, never a remote CDN (Manifest V3 forbids remote code)', async () => {
    const { BUNDLES, XLSX_EXTENSION_REPOSITORY } = await import('../src/duckdbBundles.js');
    const urls = [
      BUNDLES.mvp?.mainModule,
      BUNDLES.mvp?.mainWorker,
      BUNDLES.eh?.mainModule,
      BUNDLES.eh?.mainWorker,
      XLSX_EXTENSION_REPOSITORY,
    ];
    expect(urls.every(Boolean)).toBe(true);

    for (const url of urls) {
      expect(url).toMatch(/^chrome-extension:\/\//);
    }
  });
});
