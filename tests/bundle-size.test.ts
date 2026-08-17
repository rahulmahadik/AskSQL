/**
 * Bundle-size gate. A production integrator cares that adding AskSQL
 * doesn't bloat their app. This fails if a package's own gzipped code grows
 * past its budget (React/drivers are peers and excluded). Driver budgets allow
 * roughly double their current size; core is held just above its real figure.
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
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const CLI_ENTRY_POINTS = new Set(['cli.js', 'bin.js']);

// KB (gzipped) ceilings for each package's OWN emitted JS.
const BUDGETS: Record<string, number> = {
  // Raised only for shipped features, and kept just above the real figure: a budget with slack stops
  // measuring. Most of the climb from 45 is the MongoDB path, question routing and scope grounding,
  // the per-engine reserved words and literal rules, and the engine-written structure queries; the
  // 74->91 step was not growth but a fix, when the walk became recursive and dist/mongo was counted
  // for the first time. 96->97: the catalog checks read the statement with its row-limit tail removed,
  // and a repair now names the table that holds the missing column and the join that reaches it.
  // 97->100: the epoch floor, which catches a numeric column compared against a date, the SQLite date
  // note that tells the model which units an INTEGER column is in, and the MATCH rewrite that lets a
  // full-text query be validated at all.
  core: 100,
  // 20 -> 23: copy controls, streamed-token progress, cell tooltips, export feedback, result-grid copy.
  react: 23,
  // 12 -> 14: the CSRF/Host gate every adapter inherits, client-path confinement for file engines,
  // the link-local check covering hex, octal and IPv4-mapped forms, and the review fixes: bracketed
  // IPv6 host parsing, access-before-existence authz, and Mongo feedback/delete routing.
  server: 14,
  postgres: 14,
  mysql: 14,
  sqlite: 10,
  duckdb: 12,
};

/** Every emitted .js, at any depth: a subdirectory is shipped code like any other. */
function emittedJs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? emittedJs(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  );
}

function gzippedKb(pkg: string): number | null {
  const dist = join(root, 'packages', pkg, 'dist');
  if (!existsSync(dist)) return null;
  // Entry points are top-level, so a nested file sharing the name is still measured.
  const files = emittedJs(dist).filter((f) => !CLI_ENTRY_POINTS.has(relative(dist, f)));
  if (files.length === 0) return null;
  const buf = Buffer.concat(files.map((f) => readFileSync(f)));
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
    // Own code only (React is a peer). The same recursion correction as core's accounts for 96->113;
    // the rest is identifier normalisation, the reserved-word lists and the routing work.
    expect(core + react).toBeLessThan(122);
  });
});
