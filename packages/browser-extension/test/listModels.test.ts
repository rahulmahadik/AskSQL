import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderModels, listableBaseUrl, ModelListError } from '../src/listModels.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('listableBaseUrl', () => {
  it('defaults ollama to its local endpoint when no override is set', () => {
    expect(listableBaseUrl('ollama', undefined)).toBe('http://localhost:11434/v1');
  });

  it('honors an ollama baseURL override', () => {
    expect(listableBaseUrl('ollama', 'http://localhost:9999/v1')).toBe('http://localhost:9999/v1');
  });

  it('openai-compatible has no default - only an explicit override is listable', () => {
    expect(listableBaseUrl('openai-compatible', undefined)).toBeUndefined();
    expect(listableBaseUrl('openai-compatible', 'https://my-gateway/v1')).toBe('https://my-gateway/v1');
  });

  it('lists the known hosted providers at their official host by default', () => {
    expect(listableBaseUrl('groq', undefined)).toBe('https://api.groq.com/openai/v1');
  });

  it('has no listable endpoint for anthropic/google/azure', () => {
    expect(listableBaseUrl('anthropic', undefined)).toBeUndefined();
    expect(listableBaseUrl('google', undefined)).toBeUndefined();
    expect(listableBaseUrl('azure', undefined)).toBeUndefined();
  });
});

describe('fetchProviderModels', () => {
  let mock: ChromeMock;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns [] immediately for a provider with no listable endpoint, without granting any permission', async () => {
    expect(await fetchProviderModels('anthropic', undefined, 'key')).toEqual([]);
    expect(mock.grantedOrigins.size).toBe(0);
  });

  // NVIDIA lists its whole public catalogue; a reranking or parsing model 404s on /chat/completions.
  it('drops reranking, retrieval and parsing models from a hosted list', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          { id: 'meta/llama-3.3-70b-instruct' },
          { id: 'nvidia/nemoretriever-parse' },
          { id: 'nvidia/llama-3.2-nv-rerankqa-1b-v2' },
          { id: 'nvidia/llama-3.2-nv-embedqa-1b-v1' },
        ],
      }),
    ) as typeof fetch;
    expect(await fetchProviderModels('nvidia', undefined, 'nvapi-1')).toEqual(['meta/llama-3.3-70b-instruct']);
  });

  // Groq's real catalogue as of 2026-08-19, verified model by model against /chat/completions: six of
  // the thirteen reject a chat request ("does not support chat completions", "text classification models
  // do not support streaming", "requires terms acceptance"). The list is alphabetical, so two broken ones
  // sat at positions 2 and 3 - where a user picks - and the query failed after the model list looked fine.
  it('offers only the Groq models that can actually answer a query', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          { id: 'allam-2-7b' },
          { id: 'canopylabs/orpheus-arabic-saudi' },
          { id: 'canopylabs/orpheus-v1-english' },
          { id: 'groq/compound' },
          { id: 'groq/compound-mini' },
          { id: 'meta-llama/llama-prompt-guard-2-22m' },
          { id: 'meta-llama/llama-prompt-guard-2-86m' },
          { id: 'openai/gpt-oss-120b' },
          { id: 'openai/gpt-oss-20b' },
          { id: 'openai/gpt-oss-safeguard-20b' },
          { id: 'qwen/qwen3.6-27b' },
          { id: 'whisper-large-v3' },
          { id: 'whisper-large-v3-turbo' },
        ],
      }),
    ) as typeof fetch;
    // gpt-oss-safeguard is kept on purpose: it contains "guard" but chats, so the test is \bguard\b.
    expect(await fetchProviderModels('groq', undefined, 'gsk-test')).toEqual([
      'allam-2-7b',
      'groq/compound',
      'groq/compound-mini',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-safeguard-20b',
      'qwen/qwen3.6-27b',
    ]);
  });

  it('lists ollama models, filtering out embedding models', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { models: [{ name: 'llama3.2' }, { name: 'nomic-embed-text' }] }),
    ) as typeof fetch;
    expect(await fetchProviderModels('ollama', undefined, undefined)).toEqual(['llama3.2']);
    expect(mock.grantedOrigins.has('http://localhost/*')).toBe(true);
  });

  it('returns [] for a valid-JSON ollama response with no "models" field', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, {})) as typeof fetch;
    expect(await fetchProviderModels('ollama', undefined, undefined)).toEqual([]);
  });

  it('gives a clear, actionable message for the Ollama-origin-block 403, not a raw status', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(403, {})) as typeof fetch;
    await expect(fetchProviderModels('ollama', undefined, undefined)).rejects.toThrow(/OLLAMA_ORIGINS/);
  });

  it('reports a generic status for a non-403 ollama failure', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(500, {})) as typeof fetch;
    await expect(fetchProviderModels('ollama', undefined, undefined)).rejects.toThrow(/Ollama replied 500/);
  });

  it('lists openai-compatible models from the /models endpoint, filtering out embedding models', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { data: [{ id: 'gpt-5' }, { id: 'text-embedding-3' }] }),
    ) as typeof fetch;
    expect(await fetchProviderModels('openai', undefined, 'sk-test')).toEqual(['gpt-5']);
  });

  it('returns [] for a valid-JSON hosted-provider response with no "data" field', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, {})) as typeof fetch;
    expect(await fetchProviderModels('openai', undefined, 'sk-test')).toEqual([]);
  });

  it('skips a data entry with no id, and omits the Authorization header when there is no key', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { data: [{ id: 'gpt-5' }, {}] }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await fetchProviderModels('openai-compatible', 'https://my-gateway/v1', undefined)).toEqual(['gpt-5']);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(init?.headers).toEqual({});
  });

  it('reports an API-key-rejected message for a 401/403 from a hosted provider', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(401, {})) as typeof fetch;
    await expect(fetchProviderModels('openai', undefined, 'bad-key')).rejects.toThrow(/API key was not accepted/);
  });

  it('reports a generic status for a non-auth hosted-provider failure', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(503, {})) as typeof fetch;
    await expect(fetchProviderModels('openai', undefined, 'sk-test')).rejects.toThrow(/replied 503/);
  });

  it('throws when the origin permission is not granted, before ever fetching', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    chrome.permissions.request = async () => false; // force the grant to fail
    await expect(fetchProviderModels('ollama', undefined, undefined)).rejects.toThrow(/needs permission/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a clear error for a 200 response whose body is not valid JSON (ollama) instead of silently reporting no models', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => Promise.reject(new Error('bad json')),
    })) as unknown as typeof fetch;
    await expect(fetchProviderModels('ollama', undefined, undefined)).rejects.toThrow(/model list AskSQL understands/);
  });

  it('reports a clear error for a 200 response whose body is not valid JSON (openai-compatible) instead of silently reporting no models', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => Promise.reject(new Error('bad json')),
    })) as unknown as typeof fetch;
    await expect(fetchProviderModels('openai-compatible', 'https://my-gateway/v1', undefined)).rejects.toThrow(
      /model list AskSQL understands/,
    );
  });

  it('ModelListError carries the HTTP status alongside the message', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(500, {})) as typeof fetch;
    try {
      await fetchProviderModels('ollama', undefined, undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelListError);
      expect((err as ModelListError).status).toBe(500);
    }
  });
});
