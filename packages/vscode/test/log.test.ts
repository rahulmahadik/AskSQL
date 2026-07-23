import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetVscodeMock, window } from './vscode-mock.js';
import { log, recentLogLines, detailOf, initLog } from '../src/log.js';

beforeEach(() => resetVscodeMock());

describe('recentLogLines ring buffer', () => {
  it('records info/warn/error lines with a level prefix', () => {
    log.info('hello');
    log.warn('careful');
    log.error('broke', new Error('why'));
    const lines = recentLogLines();
    expect(lines).toContain('[info] hello');
    expect(lines).toContain('[warn] careful');
    expect(lines).toContain('[error] broke');
  });

  it('caps each line length and appends an ellipsis', () => {
    log.info('x'.repeat(400));
    const last = recentLogLines().at(-1)!;
    // "[info] " prefix + 300 chars + the ellipsis character.
    expect(last.endsWith('…')).toBe(true);
    expect(last.length).toBeLessThanOrEqual(301);
  });

  it('keeps at most RING_SIZE (200) lines, dropping the oldest', () => {
    for (let i = 0; i < 250; i++) log.info(`line ${i}`);
    const lines = recentLogLines();
    expect(lines.length).toBe(200);
    expect(lines[0]).toBe('[info] line 50');
    expect(lines.at(-1)).toBe('[info] line 249');
  });
});

describe('log channel forwarding', () => {
  it('does not throw when the channel is not initialised', () => {
    expect(() => log.info('no channel')).not.toThrow();
  });

  it('forwards to the channel once initialised', () => {
    const channel = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      dispose: vi.fn(),
    };
    window.createOutputChannel.mockReturnValue(channel as never);
    const subscriptions: unknown[] = [];
    initLog({ subscriptions } as never);
    expect(window.createOutputChannel).toHaveBeenCalledWith('AskSQL', { log: true });
    expect(subscriptions).toContain(channel);

    log.info('via channel', 1);
    expect(channel.info).toHaveBeenCalledWith('via channel', 1);

    const err = new Error('boom');
    log.error('failed', err);
    expect(channel.error).toHaveBeenCalledWith('failed', err);

    // Non-Error detail is coerced to a string before forwarding.
    log.error('failed2', 'plain');
    expect(channel.error).toHaveBeenCalledWith('failed2', 'plain');
    log.error('failed3');
    expect(channel.error).toHaveBeenCalledWith('failed3', '');
  });
});

describe('detailOf', () => {
  it('formats an Error as name: message', () => {
    expect(detailOf(new TypeError('nope'))).toBe('TypeError: nope');
  });

  it('stringifies a non-error', () => {
    expect(detailOf(42)).toBe('42');
    expect(detailOf('text')).toBe('text');
  });
});
