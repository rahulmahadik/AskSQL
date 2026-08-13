/**
 * Bundle-size gate. A production integrator cares that adding AskSQL
 * doesn't bloat their app. This fails if a package's own gzipped code grows
 * past its budget (React/drivers are peers and excluded). Budgets are set at
 * roughly current size × 2 so normal growth is fine but a regression trips.
 *
 * Command-line entry points are excluded: they are spawned as their own
 * process and never imported by an embedding app, so counting them would
 * measure something no integrator ships.
 *
 * Skips when dist is absent (run `pnpm build` first).
 */
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const CLI_ENTRY_POINTS = new Set(['cli.js', 'bin.js']);

// KB (gzipped) ceilings for each package's OWN emitted JS.
const BUDGETS: Record<string, number> = {
  // Raised only for shipped features, and kept just above the real figure: a budget with slack
  // stops measuring. History: 45->51 scope guard + Mongo, 51->54 grounding vocabularies,
  // 54->60 question routing + the ungrouped-aggregate lint, 60->63 routing precision +
  // identifier quoting, 63->65 routing words disambiguated from identifiers ("the archive table",
  // "the best selling products", "the prompts table"), 65->66 identifier normalisation plus the
  // connection identity and catalog hint that keep system-catalog queries from being guessed,
  // 67->69 each engine's own reserved words read from its catalog (MySQL reserves 262, the shared
  // guess had ~100), stored as one word list plus a bit per engine, 69->70 dollar-quoted literals,
  // qualifier handling and the per-dialect backslash rule.
  core: 70,
  // 20 -> 23: copy controls, streamed-token progress, cell tooltips, export feedback, result-grid copy.
  react: 23,
  // 12 -> 13: the CSRF/Host gate every adapter inherits, client-path confinement for
  // file engines, and the link-local check covering hex, octal and IPv4-mapped forms.
  server: 13,
  postgres: 14,
  mysql: 14,
  sqlite: 10,
  duckdb: 12,
};

function gzippedKb(pkg: string): number | null {
  const dist = join(root, 'packages', pkg, 'dist');
  if (!existsSync(dist)) return null;
  const files = readdirSync(dist).filter((f) => f.endsWith('.js') && !CLI_ENTRY_POINTS.has(f));
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
    // Own code only (React is a peer). 85 -> 91: identifier normalisation, which is what stops a
    // mixed-case Postgres schema from failing every query, the prompt's connection identity, and the
    // per-engine reserved-word lists, and the literal rules each dialect actually follows.
    expect(core + react).toBeLessThan(92);
  });
});
