import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureProviderOriginAccess } from '../src/providerAccess.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';

describe('ensureProviderOriginAccess', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('grants the origin permission and installs the Origin-strip rule for it', async () => {
    expect(await ensureProviderOriginAccess('http://localhost:11434/v1')).toBe(true);
    expect(mock.grantedOrigins.has('http://localhost/*')).toBe(true);
    expect(mock.dynamicRules.size).toBe(1);
  });

  it('installs no rule when the permission grant is refused - the rule needs host access to apply', async () => {
    chrome.permissions.request = async () => false;
    expect(await ensureProviderOriginAccess('http://localhost:11434/v1')).toBe(false);
    expect(mock.dynamicRules.size).toBe(0);
  });

  it('rejects an unusable URL before touching permissions or rules', async () => {
    await expect(ensureProviderOriginAccess('localhost:11434')).rejects.toThrow('not a valid URL');
    expect(mock.grantedOrigins.size).toBe(0);
    expect(mock.dynamicRules.size).toBe(0);
  });
});
