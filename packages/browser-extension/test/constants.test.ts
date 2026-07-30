import { describe, expect, it } from 'vitest';
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
