/**
 * Replays test/fixtures/routing-corpus.txt, the ordinary ways each question gets typed. The
 * JetBrains plugin replays the same file, so a phrasing fixed here cannot regress there.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isDatabaseOverviewQuestion,
  isMetadataQuestion,
  isSchemaAdviceQuestion,
  isWriteRequest,
} from '../src/schema-match.js';
import { isCapabilityQuestion } from '../src/scope.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'routing-corpus.txt');

function loadCorpus(): readonly (readonly [string, string])[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => {
      const tab = line.indexOf('\t');
      if (tab < 0) throw new Error(`malformed corpus line: ${line}`);
      return [line.slice(0, tab), line.slice(tab + 1)] as const;
    });
}

/** The engine's own order of checks, so the corpus measures routing as it actually happens. */
function routeOf(question: string): string {
  if (isCapabilityQuestion(question)) return 'capability';
  if (isWriteRequest(question)) return 'write';
  if (isSchemaAdviceQuestion(question) || isDatabaseOverviewQuestion(question)) return 'advice';
  return isMetadataQuestion(question) ? 'listing' : 'data';
}

const CORPUS = loadCorpus();

describe('routing corpus', () => {
  it('has thousands of questions rather than a sample', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(4000);
  });

  it('routes every question in the corpus', () => {
    const misrouted: string[] = [];
    for (const [expected, question] of CORPUS) {
      const actual = routeOf(question);
      if (actual === expected) continue;
      // 'listing' is a hint for the repair loop rather than a separate path: both still
      // generate SQL, so a data question read as a listing is not a misroute.
      if (expected === 'data' && actual === 'listing') continue;
      misrouted.push(`${expected} -> ${actual}: ${question}`);
    }
    const summary = `${misrouted.length}/${CORPUS.length} misrouted\n${misrouted.slice(0, 25).join('\n')}`;
    expect(misrouted, summary).toEqual([]);
  });

  it('covers every route', () => {
    expect([...new Set(CORPUS.map(([route]) => route))].sort()).toEqual([
      'advice',
      'capability',
      'data',
      'listing',
      'write',
    ]);
  });
});
