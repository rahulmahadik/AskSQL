/**
 * Packaging gate: every path the manifest advertises has to be in the tarball,
 * including the CDN bundle `unpkg`/`jsdelivr` serve.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  main: string;
  module: string;
  types: string;
  unpkg: string;
  jsdelivr: string;
  files: string[];
  exports: Record<string, Record<string, string>>;
  scripts: Record<string, string>;
};

describe('@asksql/widget manifest', () => {
  it('builds the CDN bundle at pack time, not only in the package build script', () => {
    const outfile = /outfile:\s*'([^']+)'/.exec(read('esbuild.mjs'))?.[1];
    expect(outfile).toBe('dist/asksql-widget.js');
    expect(pkg.unpkg).toBe(`./${outfile}`);
    expect(pkg.jsdelivr).toBe(`./${outfile}`);
    // The release runs the root build (`tsc -b`), which never emits this file; publish does run prepack.
    expect(pkg.scripts['prepack']).toContain('esbuild.mjs');
  });

  it('publishes every path it advertises', () => {
    const advertised = [
      pkg.main,
      pkg.module,
      pkg.types,
      pkg.unpkg,
      pkg.jsdelivr,
      ...Object.values(pkg.exports).flatMap((e) => Object.values(e)),
    ];
    for (const path of advertised) expect(path.startsWith('./dist/')).toBe(true);
    expect(pkg.files).toContain('dist');
  });
});
