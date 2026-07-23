import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resetVscodeMock,
  setConfig,
  configUpdates,
  createSecretStorage,
  window,
  ConfigurationTarget,
} from './vscode-mock.js';
import { apiKeyKey } from '../src/engine.js';
import { providerModels, selectModel, selectApiKey, selectProvider, promptForApiKey } from '../src/models.js';

const okJson = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

beforeEach(() => resetVscodeMock());
afterEach(() => vi.unstubAllGlobals());

describe('providerModels', () => {
  it('lists Ollama tags from /api/tags, dropping embedding models', async () => {
    setConfig({ provider: 'ollama', baseURL: '' });
    const fetchMock = vi.fn(async () => okJson({ models: [{ name: 'qwen' }, { name: 'nomic-embed-text' }, {}] }));
    vi.stubGlobal('fetch', fetchMock);
    const secrets = createSecretStorage();
    const models = await providerModels(secrets as never, 1000);
    expect(models).toEqual(['qwen']);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:11434/api/tags');
  });

  it('lists OpenAI-compatible /models with a bearer key, dropping embeddings', async () => {
    setConfig({ provider: 'openai', baseURL: '' });
    const fetchMock = vi.fn(async () => okJson({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const secrets = createSecretStorage({ [apiKeyKey('openai')]: 'sk-1' });
    const models = await providerModels(secrets as never, 1000);
    expect(models).toEqual(['gpt-4o']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.openai.com/v1/models');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-1');
  });

  it('returns empty for a provider with no listable endpoint (anthropic)', async () => {
    setConfig({ provider: 'anthropic', baseURL: '' });
    const secrets = createSecretStorage();
    expect(await providerModels(secrets as never, 1000)).toEqual([]);
  });

  it('returns empty for openai-compatible with no configured baseURL', async () => {
    setConfig({ provider: 'openai-compatible', baseURL: '' });
    const secrets = createSecretStorage();
    expect(await providerModels(secrets as never, 1000)).toEqual([]);
  });

  it('throws a UserFacingError when Ollama is not reachable', async () => {
    setConfig({ provider: 'ollama', baseURL: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, 500)),
    );
    const secrets = createSecretStorage();
    await expect(providerModels(secrets as never, 1000)).rejects.toThrow(/Ollama replied 500/);
  });

  it('reports an auth failure distinctly for a rejected key', async () => {
    setConfig({ provider: 'openai', baseURL: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, 401)),
    );
    const secrets = createSecretStorage({ [apiKeyKey('openai')]: 'bad' });
    await expect(providerModels(secrets as never, 1000)).rejects.toThrow(/API key was not accepted \(401\)/);
  });
});

describe('selectModel', () => {
  it('lists provider models and saves the picked one to global settings', async () => {
    setConfig({ provider: 'ollama', model: '', baseURL: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ models: [{ name: 'qwen' }] })),
    );
    window.showQuickPick.mockResolvedValueOnce({ label: 'qwen' });
    const secrets = createSecretStorage();
    const chosen = await selectModel(secrets as never);
    expect(chosen).toBe('qwen');
    expect(configUpdates).toContainEqual({ key: 'model', value: 'qwen', target: ConfigurationTarget.Global });
  });

  it('falls through to manual entry when the manual item is picked', async () => {
    setConfig({ provider: 'ollama', model: '', baseURL: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ models: [{ name: 'qwen' }] })),
    );
    window.showQuickPick.mockResolvedValueOnce({ label: '$(edit) Enter a model id manually...' });
    window.showInputBox.mockResolvedValueOnce('custom-model');
    const secrets = createSecretStorage();
    expect(await selectModel(secrets as never)).toBe('custom-model');
  });

  it('returns undefined when the picker is cancelled', async () => {
    setConfig({ provider: 'ollama', model: '', baseURL: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ models: [{ name: 'qwen' }] })),
    );
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage();
    expect(await selectModel(secrets as never)).toBeUndefined();
  });

  it('prompts to type an id for a non-listable provider (anthropic)', async () => {
    setConfig({ provider: 'anthropic', model: 'old', baseURL: '' });
    window.showInputBox.mockResolvedValueOnce('claude-x');
    const secrets = createSecretStorage();
    expect(await selectModel(secrets as never)).toBe('claude-x');
  });

  it('offers to re-enter the key after an auth failure, then continues manually', async () => {
    setConfig({ provider: 'openai', model: '', baseURL: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, 401)),
    );
    const secrets = createSecretStorage({ [apiKeyKey('openai')]: 'bad' });
    // First warning offers Re-enter key; supply a new key, then the retry still
    // 401s and we choose Enter manually, then type an id.
    window.showWarningMessage.mockResolvedValueOnce('Re-enter key').mockResolvedValueOnce('Enter manually');
    window.showInputBox.mockResolvedValueOnce('new-key').mockResolvedValueOnce('typed-model');
    expect(await selectModel(secrets as never)).toBe('typed-model');
    expect(secrets._map.get(apiKeyKey('openai'))).toBe('new-key');
  });
});

describe('selectApiKey', () => {
  it('stores a pasted key for the chosen provider', async () => {
    setConfig({ provider: 'openai' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'groq' });
    window.showInputBox.mockResolvedValueOnce('  gsk-123  ');
    const secrets = createSecretStorage();
    await selectApiKey(secrets as never);
    expect(secrets._map.get(apiKeyKey('groq'))).toBe('gsk-123');
  });

  it('clears an existing key on empty input', async () => {
    setConfig({ provider: 'openai' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'openai' });
    window.showInputBox.mockResolvedValueOnce('   ');
    const secrets = createSecretStorage({ [apiKeyKey('openai')]: 'existing' });
    await selectApiKey(secrets as never);
    expect(secrets._map.has(apiKeyKey('openai'))).toBe(false);
  });

  it('leaves the key untouched when the input is cancelled', async () => {
    window.showQuickPick.mockResolvedValueOnce({ label: 'openai' });
    window.showInputBox.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage({ [apiKeyKey('openai')]: 'existing' });
    await selectApiKey(secrets as never);
    expect(secrets._map.get(apiKeyKey('openai'))).toBe('existing');
  });

  it('does nothing when the provider picker is cancelled', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage();
    await selectApiKey(secrets as never);
    expect(window.showInputBox).not.toHaveBeenCalled();
  });
});

describe('promptForApiKey', () => {
  it('stores a value and keeps an existing key on blank', async () => {
    const secrets = createSecretStorage();
    window.showInputBox.mockResolvedValueOnce('sk-new');
    await promptForApiKey(secrets as never, 'openai');
    expect(secrets._map.get(apiKeyKey('openai'))).toBe('sk-new');

    secrets._map.set(apiKeyKey('openai'), 'keep');
    window.showInputBox.mockResolvedValueOnce('   ');
    await promptForApiKey(secrets as never, 'openai');
    expect(secrets._map.get(apiKeyKey('openai'))).toBe('keep');
  });
});

describe('selectProvider', () => {
  it('commits the provider, asks for a key, and picks a model', async () => {
    setConfig({ provider: 'ollama', model: '', baseURL: '' });
    // provider pick, then model pick (typed via input for anthropic).
    window.showQuickPick.mockResolvedValueOnce({ label: 'anthropic' });
    window.showInputBox
      .mockResolvedValueOnce('sk-anthropic') // promptForApiKey
      .mockResolvedValueOnce('claude-3'); // typeModelId
    const secrets = createSecretStorage();
    expect(await selectProvider(secrets as never)).toBe(true);
    expect(configUpdates).toContainEqual({ key: 'provider', value: 'anthropic', target: ConfigurationTarget.Global });
    expect(secrets._map.get(apiKeyKey('anthropic'))).toBe('sk-anthropic');
  });

  it('collects a base URL before committing openai-compatible', async () => {
    setConfig({ provider: 'ollama', model: '', baseURL: '' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'openai-compatible' });
    window.showInputBox
      .mockResolvedValueOnce('https://c.example.com/v1') // base URL
      .mockResolvedValueOnce('sk-compat') // api key
      .mockResolvedValueOnce('local-model'); // model id (no listable fetch)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ data: [] })),
    );
    const secrets = createSecretStorage();
    expect(await selectProvider(secrets as never)).toBe(true);
    expect(configUpdates).toContainEqual({
      key: 'baseURL',
      value: 'https://c.example.com/v1',
      target: ConfigurationTarget.Global,
    });
  });

  it('drops a stale baseURL when switching to a hosted provider', async () => {
    setConfig({ provider: 'openai-compatible', model: '', baseURL: 'https://old/v1' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'openai' });
    window.showInputBox
      .mockResolvedValueOnce('sk-openai') // api key
      .mockResolvedValueOnce(''); // model id cancelled/empty -> no model saved
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ data: [] })),
    );
    const secrets = createSecretStorage();
    await selectProvider(secrets as never);
    expect(configUpdates).toContainEqual({ key: 'baseURL', value: undefined, target: ConfigurationTarget.Global });
  });

  it('returns false when the provider picker is cancelled', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage();
    expect(await selectProvider(secrets as never)).toBe(false);
  });

  it('returns false when openai-compatible base URL is cancelled', async () => {
    setConfig({ provider: 'ollama', baseURL: '' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'openai-compatible' });
    window.showInputBox.mockResolvedValueOnce(undefined);
    const secrets = createSecretStorage();
    expect(await selectProvider(secrets as never)).toBe(false);
  });
});
