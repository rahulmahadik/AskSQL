import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureOriginAccess } from '../src/originAccess.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';

describe('ensureOriginAccess', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('requests and grants access for a not-yet-permitted URL', async () => {
    expect(await ensureOriginAccess('https://api.groq.com/openai/v1')).toBe(true);
    expect(mock.grantedOrigins.has('https://api.groq.com/*')).toBe(true);
  });

  it('does not call permissions.request when already granted', async () => {
    mock.grantedOrigins.add('https://api.groq.com/*');
    expect(await ensureOriginAccess('https://api.groq.com/openai/v1')).toBe(true);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('throws a friendly error for a bogus-scheme URL like "localhost:3000"', async () => {
    await expect(ensureOriginAccess('localhost:3000')).rejects.toThrow(/not a valid URL/);
  });

  it('throws a friendly error for a string the URL constructor rejects outright', async () => {
    await expect(ensureOriginAccess('not a url at all')).rejects.toThrow(/not a valid URL/);
  });
});
