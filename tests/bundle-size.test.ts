/**
 * Bundle-size gate. A production integrator cares that adding AskSQL
 * doesn't bloat their app. This fails if a package's own gzipped code grows
 * past its budget (React/drivers are peers and excluded). Budgets are set at
 * roughly current size × 2 so normal growth is fine but a regression trips.
 *
 * Skips when dist is absent (run `pnpm build` first).
 */
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

// KB (gzipped) ceilings for each package's OWN emitted JS.
const BUDGETS: Record<string, number> = {
  core: 45,
  react: 20,
  server: 12,
  postgres: 14,
  mysql: 14,
  sqlite: 10,
  duckdb: 12,
};

function gzippedKb(pkg: string): number | null {
  const dist = join(root, 'packages', pkg, 'dist');
  if (!existsSync(dist)) return null;
  const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
  if (files.length === 0) return null;
  const buf = Buffer.concat(files.map((f) => readFileSync(join(dist, f))));
  return gzipSync(buf).length / 1024;
}

describe('bundle-size budgets (gzipped, own code)', () => {
  for (const [pkg, budget] of Object.entries(BUDGETS)) {
    it(`@asksql/${pkg} stays under ${budget} KB gz`, () => {
      const kb = gzippedKb(pkg);
      if (kb === null) {
        console.warn(`[skip] packages/${pkg}/dist not built`);
        return;
      }
      expect(kb).toBeLessThan(budget);
    });
  }

  it('the whole client path (core + react) is lean for embedding', () => {
    const core = gzippedKb('core');
    const react = gzippedKb('react');
    if (core === null || react === null) return;
    // Own code only (React is a peer): must stay well under the 80 KB budget.
    expect(core + react).toBeLessThan(80);
  });
});
