/**
 * The word lists core and the Kotlin port share must stay identical - a word on one side only
 * means the two IDEs disagree about whether an answer invented a name. The prompt-parity vectors
 * cover prompts, not these. Compares the sources directly, so it needs no build.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TS = readFileSync(`${root}packages/core/src/grounding.ts`, 'utf8');
const KT = readFileSync(
  `${root}packages/jetbrains/src/main/kotlin/com/rahulmahadik/asksql/ide/engine/Grounding.kt`,
  'utf8',
);

/** Words between a declaration and the next one, in either language's quoting style. */
function words(source: string, from: string, to: string, quote: RegExp): Set<string> {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start, `could not find "${from}"`).toBeGreaterThan(-1);
  expect(end, `could not find "${to}"`).toBeGreaterThan(start);
  const block = source.slice(start, end);
  return new Set(
    [...block.matchAll(quote)].flatMap((m) => m[1]!.trim().split(/\s+/)).filter((w) => /^[a-z_]+$/.test(w)),
  );
}

const TS_QUOTE = /'([a-z_ ]+)'/g;
const KT_QUOTE = /"([a-z_ ]+)"/g;

describe('the shared word lists are identical in TypeScript and Kotlin', () => {
  const CASES = [
    {
      name: 'SQL_VOCABULARY',
      ts: words(TS, 'const SQL_VOCABULARY', 'const NON_IDENTIFIER_SNAKE', TS_QUOTE),
      kt: words(KT, 'private val SQL_VOCABULARY', 'private val NON_IDENTIFIER_SNAKE', KT_QUOTE),
    },
    {
      name: 'NON_IDENTIFIER_SNAKE',
      ts: words(TS, 'const NON_IDENTIFIER_SNAKE', 'const ALIAS_RE', TS_QUOTE),
      kt: words(KT, 'private val NON_IDENTIFIER_SNAKE', 'private val MONGO_NON_IDENTIFIER', KT_QUOTE),
    },
    {
      name: 'MONGO_NON_IDENTIFIER',
      ts: words(TS, 'const MONGO_NON_IDENTIFIER', 'export interface GroundingOptions', TS_QUOTE),
      kt: words(KT, 'private val MONGO_NON_IDENTIFIER', 'private val MONGO_OUTPUT_ALIAS_RE', KT_QUOTE),
    },
    {
      name: 'EVERYDAY_NAMES',
      ts: words(TS, 'const EVERYDAY_NAMES', 'export function mentionsCatalogName', TS_QUOTE),
      kt: words(KT, 'private val EVERYDAY_NAMES', 'private val WORD_TOKEN_RE', KT_QUOTE),
    },
  ];

  for (const { name, ts, kt } of CASES) {
    it(`${name} matches`, () => {
      expect(ts.size, `${name} looks empty on the TypeScript side - did the block move?`).toBeGreaterThan(5);
      expect([...ts].sort()).toEqual([...kt].sort());
    });
  }
});
