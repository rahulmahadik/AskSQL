/**
 * The build step that bakes the DuckDB `excel` WASM into the store package.
 * Loaded through a runtime URL because it is a plain .mjs build script.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface FetchScript {
  isDuckDbExtensionUrl: (url: string) => boolean;
  pinDigest: (lock: Record<string, string>, relative: string, bytes: Buffer) => { digest: string; recorded: boolean };
}

const script = (await import(
  new URL('../scripts/fetch-duckdb-extensions.mjs', import.meta.url).href
)) as unknown as FetchScript;

const lockfile = JSON.parse(
  readFileSync(new URL('../scripts/duckdb-extensions.lock.json', import.meta.url), 'utf8'),
) as Record<string, string>;

describe('isDuckDbExtensionUrl', () => {
  it('accepts the real extension host', () => {
    expect(
      script.isDuckDbExtensionUrl('https://extensions.duckdb.org/v1.4.3/wasm_eh/excel.duckdb_extension.wasm'),
    ).toBe(true);
    expect(script.isDuckDbExtensionUrl('https://duckdb.org/x.wasm')).toBe(true);
  });

  it('rejects a lookalike domain that merely contains duckdb.org', () => {
    expect(script.isDuckDbExtensionUrl('https://evil-duckdb.org.attacker.example/excel.wasm')).toBe(false);
    expect(script.isDuckDbExtensionUrl('https://duckdb.org.attacker.example/excel.wasm')).toBe(false);
    expect(script.isDuckDbExtensionUrl('https://notduckdb.org/excel.wasm')).toBe(false);
  });

  it('rejects a non-http scheme and an unparseable URL', () => {
    expect(script.isDuckDbExtensionUrl('file:///etc/passwd')).toBe(false);
    expect(script.isDuckDbExtensionUrl('not a url')).toBe(false);
  });
});

describe('pinDigest', () => {
  const bytes = Buffer.from('wasm-bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');

  it('records the digest the first time a path is seen', () => {
    const lock: Record<string, string> = {};
    expect(script.pinDigest(lock, 'v1/excel.wasm', bytes)).toEqual({ digest, recorded: true });
    expect(lock['v1/excel.wasm']).toBe(digest);
  });

  it('accepts bytes that match the pin', () => {
    const lock = { 'v1/excel.wasm': digest };
    expect(script.pinDigest(lock, 'v1/excel.wasm', bytes).recorded).toBe(false);
  });

  it('fails the build when the CDN serves different bytes for a pinned path', () => {
    const lock = { 'v1/excel.wasm': digest };
    expect(() => script.pinDigest(lock, 'v1/excel.wasm', Buffer.from('tampered'))).toThrow(/not the pinned/);
  });
});

describe('duckdb-extensions.lock.json', () => {
  it('pins every bundled extension as a sha256 hex digest', () => {
    const entries = Object.entries(lockfile);
    expect(entries.length).toBeGreaterThan(0);
    for (const [relative, digest] of entries) {
      expect(relative).toMatch(/\.duckdb_extension\.wasm$/);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
