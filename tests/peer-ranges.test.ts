/**
 * Published peer ranges must not be exact pins. pnpm replaces `workspace:*` with the exact current
 * version on publish, so every connector release put consumers into peer conflict - and changesets
 * majored the server on any connector minor. `tools/release-preflight.mjs` catches the version
 * consequence; this catches the cause in `pnpm test`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const packagesDir = fileURLToPath(new URL('../packages', import.meta.url));

const manifests = readdirSync(packagesDir)
  .map((dir) => join(packagesDir, dir, 'package.json'))
  .filter((p) => existsSync(p))
  .map((p) => ({ path: p, json: JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> }))
  .filter(({ json }) => json['private'] !== true);

describe('peer dependency ranges are publishable', () => {
  it('finds the workspace manifests', () => {
    expect(manifests.length).toBeGreaterThan(5);
  });

  for (const { path, json } of manifests) {
    const peers = (json['peerDependencies'] ?? {}) as Record<string, string>;
    const name = String(json['name']);
    const pinned = Object.entries(peers).filter(([, range]) => range === 'workspace:*' || range === 'workspace:~');

    it(`${name} declares no exact-pin peer range`, () => {
      expect(
        pinned,
        `${path}: pnpm turns these into an exact version on publish, which forces a peer conflict ` +
          `on every release of the dependency. Use a range such as "workspace:>=0.1.0".`,
      ).toEqual([]);
    });
  }
});

describe('changesets keeps the peer-dependent major rule switched off', () => {
  // Without this, changesets majors a package whenever a peer gets a non-patch bump, whatever
  // the range says - which is precisely how the accidental @asksql/server@1.0.0 arose.
  it('sets onlyUpdatePeerDependentsWhenOutOfRange', () => {
    const config = JSON.parse(
      readFileSync(fileURLToPath(new URL('../.changeset/config.json', import.meta.url)), 'utf8'),
    ) as Record<string, Record<string, unknown>>;
    const experimental = config['___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH'];
    expect(experimental?.['onlyUpdatePeerDependentsWhenOutOfRange']).toBe(true);
  });
});
