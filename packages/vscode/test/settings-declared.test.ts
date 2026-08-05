/** A setting the manifest does not declare reads as undefined, so the feature is dead. */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, unknown> } };
};

const declared = new Set(
  Object.keys(pkg.contributes.configuration.properties)
    .filter((key) => key.startsWith('asksql.'))
    .map((key) => key.slice('asksql.'.length)),
);

/** Matches the three shapes the source uses to read a setting, capturing the key. */
const READS = /\bcfg(?:\(\))?\.get<[^>]*>\('([A-Za-z][A-Za-z0-9]*)'\)/g;

function keysReadInSource(): Map<string, string> {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const found = new Map<string, string>();
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(srcDir + file, 'utf8');
    for (const match of text.matchAll(READS)) found.set(match[1]!, file);
  }
  return found;
}

describe('every setting the source reads is contributed', () => {
  const read = keysReadInSource();

  it('finds the reads at all, so a refactor cannot quietly empty this test', () => {
    expect(read.size).toBeGreaterThanOrEqual(8);
    expect([...read.keys()]).toContain('provider');
  });

  for (const [key, file] of read) {
    it(`asksql.${key} (read in ${file}) is declared in package.json`, () => {
      expect(declared).toContain(key);
    });
  }
});
