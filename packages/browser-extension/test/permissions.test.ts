import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasOriginPermission,
  removeAllGrantedOriginPermissions,
  requestOriginPermission,
  toOriginPattern,
} from '../src/permissions.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';

describe('toOriginPattern', () => {
  it('strips the port from an http URL', () => {
    expect(toOriginPattern('http://localhost:11434/v1')).toBe('http://localhost/*');
  });

  it('strips the port from an https URL', () => {
    expect(toOriginPattern('https://api.example.com:8443/foo/bar')).toBe('https://api.example.com/*');
  });

  it('produces the same pattern regardless of path', () => {
    expect(toOriginPattern('http://localhost:11434/v1')).toBe(toOriginPattern('http://localhost:11434/other/path'));
  });

  it('handles a URL with no port', () => {
    expect(toOriginPattern('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/*');
  });
});

describe('permissions against a mocked chrome.permissions', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('hasOriginPermission is false before any grant', async () => {
    expect(await hasOriginPermission('http://localhost:11434/v1')).toBe(false);
  });

  it('requestOriginPermission grants the port-stripped origin', async () => {
    expect(await requestOriginPermission('http://localhost:11434/v1')).toBe(true);
    expect(mock.grantedOrigins.has('http://localhost/*')).toBe(true);
  });

  it('hasOriginPermission is true after a matching grant', async () => {
    await requestOriginPermission('http://localhost:11434/v1');
    expect(await hasOriginPermission('http://localhost:11434/v1')).toBe(true);
    // A different port on the same host is still covered - the whole point of stripping it.
    expect(await hasOriginPermission('http://localhost:9999/v1')).toBe(true);
  });

  it('a grant for one host does not cover a different host', async () => {
    await requestOriginPermission('http://localhost:11434/v1');
    expect(await hasOriginPermission('https://api.openai.com/v1')).toBe(false);
  });

  it('removeAllGrantedOriginPermissions clears every granted origin', async () => {
    await requestOriginPermission('http://localhost:11434/v1');
    await requestOriginPermission('https://api.openai.com/v1');
    expect(mock.grantedOrigins.size).toBe(2);
    await removeAllGrantedOriginPermissions();
    expect(mock.grantedOrigins.size).toBe(0);
  });

  it('removeAllGrantedOriginPermissions is a no-op when nothing was granted', async () => {
    await expect(removeAllGrantedOriginPermissions()).resolves.toBeUndefined();
  });

  it('removeAllGrantedOriginPermissions tolerates chrome.permissions.getAll() omitting origins entirely', async () => {
    chrome.permissions.getAll = (async () => ({ permissions: [] })) as typeof chrome.permissions.getAll;
    await expect(removeAllGrantedOriginPermissions()).resolves.toBeUndefined();
  });
});
