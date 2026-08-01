import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PENDING_QUESTION_KEY, PENDING_QUESTION_MAX_AGE_MS } from '../src/constants.js';

// These are trivial by nature (plain constants) - this only guards the two
// properties that actually matter if someone edits them: the key is a
// non-empty string (background.ts and the side panel both key off it), and
// the staleness window is a sane positive duration, not e.g. accidentally 0
// (which would make ask-about-selection never fire) or negative.
describe('constants', () => {
  it('PENDING_QUESTION_KEY is a non-empty string', () => {
    expect(typeof PENDING_QUESTION_KEY).toBe('string');
    expect(PENDING_QUESTION_KEY.length).toBeGreaterThan(0);
  });

  it('PENDING_QUESTION_MAX_AGE_MS is a sane positive duration', () => {
    expect(PENDING_QUESTION_MAX_AGE_MS).toBeGreaterThan(0);
  });
});

/**
 * The store reads manifest.json; humans read package.json. They are maintained by hand in two
 * files, and a release that ships them out of step is invisible until the store rejects it.
 */
describe('extension version', () => {
  it('is identical in manifest.json and package.json', async () => {
    const read = async (file: string) =>
      JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).version;
    expect(await read('manifest.json')).toBe(await read('package.json'));
  });
});
