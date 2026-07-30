import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportError } from '../src/errorReporting.js';

describe('reportError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the real error to the console and returns its message', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('endpoint unreachable');

    expect(reportError('Test provider', err)).toBe('endpoint unreachable');
    expect(consoleError).toHaveBeenCalledWith('AskSQL: Test provider failed', err);
  });

  it('stringifies a non-Error thrown value instead of dropping it', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(reportError('Fetch models', 'a raw string rejection')).toBe('a raw string rejection');
    expect(consoleError).toHaveBeenCalledWith('AskSQL: Fetch models failed', 'a raw string rejection');
  });
});
