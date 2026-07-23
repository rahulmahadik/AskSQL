import { describe, it, expect } from 'vitest';
import { AskSqlError } from '@asksql/core';
import { UserFacingError, userMessage, setupAction } from '../src/errors.js';

describe('UserFacingError', () => {
  it('carries the message verbatim and an optional setup action', () => {
    const setup = { action: 'asksql.setApiKey', actionLabel: 'Update API key' };
    const err = new UserFacingError('do the thing', setup);
    expect(err.message).toBe('do the thing');
    expect(err.name).toBe('UserFacingError');
    expect(err.setup).toBe(setup);
  });

  it('has no setup action by default', () => {
    expect(new UserFacingError('x').setup).toBeUndefined();
  });
});

describe('setupAction', () => {
  it('returns the action a UserFacingError carries', () => {
    const setup = { action: 'asksql.selectProvider', actionLabel: 'Set up provider' };
    expect(setupAction(new UserFacingError('m', setup))).toBe(setup);
  });

  it('maps LLM_AUTH and LLM_UNREACHABLE codes to their fix-it actions', () => {
    expect(setupAction(new AskSqlError('LLM_AUTH'))).toEqual({
      action: 'asksql.setApiKey',
      actionLabel: 'Update API key',
    });
    expect(setupAction(new AskSqlError('LLM_UNREACHABLE'))).toEqual({
      action: 'asksql.selectProvider',
      actionLabel: 'Set up provider',
    });
  });

  it('does not offer a model-picker for CONFIG_ERROR (also covers sqlite/connector failures)', () => {
    expect(setupAction(new AskSqlError('CONFIG_ERROR'))).toBeUndefined();
  });

  it('returns undefined for plain errors and non-errors', () => {
    expect(setupAction(new Error('boom'))).toBeUndefined();
    expect(setupAction('nope')).toBeUndefined();
    expect(setupAction(undefined)).toBeUndefined();
  });
});

describe('userMessage', () => {
  it('shows an AskSqlError userMessage as-is', () => {
    const err = new AskSqlError('LLM_AUTH', { userMessage: 'Bad key.' });
    expect(userMessage(err)).toBe('Bad key.');
  });

  it('shows a UserFacingError message as-is', () => {
    expect(userMessage(new UserFacingError('be specific'))).toBe('be specific');
  });

  it('maps a driver code on the top-level error', () => {
    expect(userMessage({ code: 'ECONNREFUSED' })).toMatch(/refused the connection/);
    expect(userMessage({ code: 'ENOTFOUND' })).toMatch(/host could not be found/);
  });

  it('maps a Postgres SQLSTATE and a MySQL ER_ code', () => {
    expect(userMessage({ code: '28P01' })).toMatch(/password was not accepted/);
    expect(userMessage({ code: 'ER_ACCESS_DENIED_ERROR' })).toMatch(/user name or password/);
  });

  it('walks the cause chain to find the code', () => {
    const err = new Error('outer');
    (err as { cause?: unknown }).cause = { code: 'ETIMEDOUT' };
    expect(userMessage(err)).toMatch(/did not respond in time/);
  });

  it('stops walking a self-referential cause chain instead of looping', () => {
    const err: { cause?: unknown } = {};
    err.cause = err;
    expect(userMessage(err)).toMatch(/Something went wrong/);
  });

  it('falls back to the generic line for an unknown code', () => {
    expect(userMessage({ code: 'WHO_KNOWS' })).toMatch(/Something went wrong/);
    expect(userMessage(new Error('raw'))).toMatch(/Something went wrong/);
  });
});
