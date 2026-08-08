/**
 * Published peer ranges must not be exact pins. pnpm replaces `workspace:*` with the exact current
 * version on publish, so every connector release put consumers into peer conflict - and changesets
 * majored the server on any connector minor. `tools/release-preflight.mjs` catches the version
 * consequence; this catches the cause in `pnpm test`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const packagesDir = fileURLToPath(new URL('../packages', import.meta.url));

const manifests = readdirSync(packagesDir)
  .map((dir) => ({ dir: join(packagesDir, dir), path: join(packagesDir, dir, 'package.json') }))
  .filter(({ path }) => existsSync(path))
  .map(({ dir, path }) => ({
    dir,
    path,
    json: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>,
  }))
  .filter(({ json }) => json['private'] !== true);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry)) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** True when the file emits an import of @asksql/core; `import type` and type-only names are erased. */
function importsCoreAtRuntime(text: string): boolean {
  if (/\bimport\s*\(\s*['"]@asksql\/core(?:\/[^'"]*)?['"]\s*\)/.test(text)) return true;
  if (/(?:^|\n)\s*import\s+['"]@asksql\/core(?:\/[^'"]*)?['"]/.test(text)) return true;
  for (const [, clause, spec] of text.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g,
  )) {
    if (!/^@asksql\/core(\/|$)/.test(spec)) continue;
    if (/^type\b/.test(clause.trim())) continue;
    const braces = /\{([\s\S]*)\}/.exec(clause);
    // A default or namespace binding is always emitted; otherwise every name must say `type`.
    const bareBinding = clause
      .replace(/\{[\s\S]*\}/, '')
      .replace(/,/g, '')
      .trim();
    if (bareBinding || !braces) return true;
    const names = braces[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.some((n) => !/^type\s/.test(n))) return true;
  }
  return false;
}

const coreRuntimeImporters = manifests.filter(
  ({ dir, json }) =>
    json['name'] !== '@asksql/core' &&
    sourceFiles(join(dir, 'src')).some((f) => importsCoreAtRuntime(readFileSync(f, 'utf8'))),
);

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

/**
 * A regular `dependencies` entry lets npm install a second copy of core under the package when the
 * consumer pins a different version, and `instanceof AskSqlError` then returns false. Only a peer
 * makes npm resolve one shared core. Derived from the sources, so a new connector is covered.
 */
describe('@asksql/core is a peer wherever it is imported at runtime', () => {
  it('finds the packages that import core at runtime', () => {
    expect(coreRuntimeImporters.map(({ json }) => json['name']).sort()).toContain('@asksql/sqlite');
    expect(coreRuntimeImporters.length).toBeGreaterThanOrEqual(8);
  });

  for (const { path, json } of coreRuntimeImporters) {
    const name = String(json['name']);
    const peers = (json['peerDependencies'] ?? {}) as Record<string, string>;
    const deps = (json['dependencies'] ?? {}) as Record<string, string>;
    const meta = (json['peerDependenciesMeta'] ?? {}) as Record<string, { optional?: boolean }>;

    it(`${name} declares @asksql/core as a required peer`, () => {
      expect(
        peers['@asksql/core'],
        `${path}: imports @asksql/core at runtime without declaring it as a peer`,
      ).toBeTruthy();
      expect(
        deps['@asksql/core'],
        `${path}: core must be a peer only; a dependency installs a second copy`,
      ).toBeUndefined();
      expect(meta['@asksql/core']?.optional, `${path}: the core peer must not be optional`).not.toBe(true);
      // pnpm publishes `workspace:0.6.0` as the exact version, which the next core release puts
      // straight back into conflict.
      expect(peers['@asksql/core'], `${path}: the core peer must be a range, not an exact pin`).toMatch(
        /^workspace:(>=|\^|~)/,
      );
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
