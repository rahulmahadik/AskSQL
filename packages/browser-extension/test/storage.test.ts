import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addConnection,
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_PROVIDER_SETTINGS,
  getConnections,
  getEngineSettings,
  getLastConnectionId,
  getProviderSettings,
  getWarningAcknowledged,
  setLastConnectionId,
  removeConnection,
  resetAll,
  resetSettingsToDefaults,
  setConnections,
  setEngineSettings,
  setProviderSettings,
  setWarningAcknowledged,
} from '../src/storage.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';

describe('last connection', () => {
  beforeEach(() => {
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('is undefined until one has been opened', async () => {
    expect(await getLastConnectionId()).toBeUndefined();
  });

  it('round-trips the id the panel should reopen', async () => {
    await setLastConnectionId('file_abc');
    expect(await getLastConnectionId()).toBe('file_abc');
  });

  it('ignores a stored value that is not a string', async () => {
    await chrome.storage.local.set({ 'asksql.lastConnection': 42 });
    expect(await getLastConnectionId()).toBeUndefined();
  });
});

describe('provider settings', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('returns defaults when nothing is stored', async () => {
    expect(await getProviderSettings()).toEqual(DEFAULT_PROVIDER_SETTINGS);
  });

  it('round-trips a saved value', async () => {
    await setProviderSettings({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'sk-1' });
    expect(await getProviderSettings()).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'sk-1' });
  });

  it('merges partial stored data over the defaults', async () => {
    mock.local.set('asksql.provider', { provider: 'openai' });
    const settings = await getProviderSettings();
    expect(settings.provider).toBe('openai');
    expect(settings.model).toBe(DEFAULT_PROVIDER_SETTINGS.model);
  });
});

describe('engine settings', () => {
  beforeEach(() => {
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('returns defaults when nothing is stored', async () => {
    expect(await getEngineSettings()).toEqual(DEFAULT_ENGINE_SETTINGS);
  });

  it('round-trips a saved value', async () => {
    const custom = {
      maxRows: 50,
      requireApproval: true,
      sqlDisplayPlacement: 'before' as const,
      answerSchemaQuestions: true,
      maxSchemaTokens: 12000,
      customInstructions: 'Prefer the reporting views.',
    };
    await setEngineSettings(custom);
    expect(await getEngineSettings()).toEqual(custom);
  });

  it('refuses a stored row cap the guard would turn into LIMIT -1', async () => {
    await chrome.storage.local.set({ 'asksql.engine': { maxRows: -1 } });
    expect((await getEngineSettings()).maxRows).toBe(DEFAULT_ENGINE_SETTINGS.maxRows);
  });

  it('bounds a stored value that is out of range or not a number at all', async () => {
    await chrome.storage.local.set({ 'asksql.engine': { maxRows: 999_999, maxSchemaTokens: 'lots' } });
    const settings = await getEngineSettings();
    expect(settings.maxRows).toBe(10_000);
    expect(settings.maxSchemaTokens).toBe(DEFAULT_ENGINE_SETTINGS.maxSchemaTokens);
  });
});

describe('connections', () => {
  beforeEach(() => {
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('starts empty', async () => {
    expect(await getConnections()).toEqual([]);
  });

  it('addConnection appends and returns the new list', async () => {
    const next = await addConnection({ id: 'a', name: 'Local', baseUrl: 'http://localhost:3000/asksql' });
    expect(next).toHaveLength(1);
    expect(await getConnections()).toEqual(next);
  });

  it('addConnection with a duplicate id replaces the existing entry, not append', async () => {
    await addConnection({ id: 'a', name: 'Local', baseUrl: 'http://localhost:3000/asksql' });
    const next = await addConnection({ id: 'a', name: 'Renamed', baseUrl: 'http://localhost:3000/asksql' });
    expect(next).toHaveLength(1);
    expect(next[0]!.name).toBe('Renamed');
  });

  it('removeConnection drops only the matching id', async () => {
    await addConnection({ id: 'a', name: 'A', baseUrl: 'http://localhost:1' });
    await addConnection({ id: 'b', name: 'B', baseUrl: 'http://localhost:2' });
    const next = await removeConnection('a');
    expect(next.map((c) => c.id)).toEqual(['b']);
  });

  it('removeConnection on an unknown id is a no-op', async () => {
    await addConnection({ id: 'a', name: 'A', baseUrl: 'http://localhost:1' });
    const next = await removeConnection('does-not-exist');
    expect(next).toHaveLength(1);
  });

  it('setConnections replaces the whole list', async () => {
    await addConnection({ id: 'a', name: 'A', baseUrl: 'http://localhost:1' });
    await setConnections([{ id: 'b', name: 'B', baseUrl: 'http://localhost:2' }]);
    expect((await getConnections()).map((c) => c.id)).toEqual(['b']);
  });
});

describe('warning acknowledgement', () => {
  beforeEach(() => {
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('defaults to false', async () => {
    expect(await getWarningAcknowledged()).toBe(false);
  });

  it('round-trips true', async () => {
    await setWarningAcknowledged(true);
    expect(await getWarningAcknowledged()).toBe(true);
  });
});

describe('resetAll', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('clears every stored setting', async () => {
    await setProviderSettings({ provider: 'groq', model: 'x', apiKey: 'secret' });
    await addConnection({ id: 'a', name: 'A', baseUrl: 'http://localhost:1' });
    await setWarningAcknowledged(true);

    await resetAll();

    expect(await getProviderSettings()).toEqual(DEFAULT_PROVIDER_SETTINGS);
    expect(await getConnections()).toEqual([]);
    expect(await getWarningAcknowledged()).toBe(false);
  });

  it('revokes every granted optional host permission, not just storage', async () => {
    await chrome.permissions.request({ origins: ['http://localhost/*'] });
    expect(mock.grantedOrigins.size).toBe(1);

    await resetAll();

    expect(mock.grantedOrigins.size).toBe(0);
  });
});

describe('resetSettingsToDefaults', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('puts provider and engine back to defaults', async () => {
    await setProviderSettings({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-1' });
    await setEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, maxRows: 5000, requireApproval: true });

    await resetSettingsToDefaults();

    expect(await getProviderSettings()).toEqual(DEFAULT_PROVIDER_SETTINGS);
    expect(await getEngineSettings()).toEqual(DEFAULT_ENGINE_SETTINGS);
  });

  it('keeps connections and their data, which is the whole point of the narrower reset', async () => {
    await addConnection({ id: 'c1', name: 'Server', baseUrl: 'http://localhost:3000' });
    mock.local.set('asksql.fileConnections', [{ id: 'f1', name: 'Files', tables: ['t'] }]);
    mock.opfsFiles.add('asksql-conn-f1.db');

    await resetSettingsToDefaults();

    expect(await getConnections()).toHaveLength(1);
    expect(mock.local.get('asksql.fileConnections')).toHaveLength(1);
    expect(mock.opfsFiles.has('asksql-conn-f1.db')).toBe(true);
  });

  it('clears the acknowledged API-key warning, so it shows again for a fresh key', async () => {
    await setWarningAcknowledged(true);
    await resetSettingsToDefaults();
    expect(await getWarningAcknowledged()).toBe(false);
  });

  it('removes the provider Origin-strip rule along with the provider settings', async () => {
    mock.dynamicRules.set(1, { id: 1 });
    await resetSettingsToDefaults();
    expect(mock.dynamicRules.size).toBe(0);
  });
});
