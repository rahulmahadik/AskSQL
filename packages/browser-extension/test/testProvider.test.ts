import { describe, expect, it, vi } from 'vitest';

vi.mock('@asksql/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@asksql/core')>();
  return { ...actual, resolveModel: vi.fn() };
});
// Keep the real APICallError (testProvider.ts does `instanceof APICallError`,
// which breaks if the mock replaces it with undefined) - only generateText is faked.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

import { resolveModel } from '@asksql/core';
import { generateText, APICallError } from 'ai';
import { testProviderConnectivity } from '../src/testProvider.js';

describe('testProviderConnectivity', () => {
  it('resolves the model then asks it a trivial prompt', async () => {
    const fakeModel = { modelId: 'fake' };
    vi.mocked(resolveModel).mockResolvedValue(fakeModel as never);
    vi.mocked(generateText).mockResolvedValue({} as never);

    await testProviderConnectivity({ provider: 'ollama', model: 'llama3.2' });

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ model: fakeModel, prompt: expect.any(String) }),
    );
  });

  it('propagates a resolveModel failure (bad config) as-is', async () => {
    vi.mocked(resolveModel).mockRejectedValue(new Error('No AI model is configured.'));
    await expect(testProviderConnectivity({ provider: 'ollama', model: '' })).rejects.toThrow('No AI model is configured.');
  });

  it('propagates a generateText failure (auth/connectivity error), proving this is a real network check', async () => {
    vi.mocked(resolveModel).mockResolvedValue({ modelId: 'fake' } as never);
    vi.mocked(generateText).mockRejectedValue(new Error('401 unauthorized'));
    await expect(testProviderConnectivity({ provider: 'openai', model: 'gpt-5', apiKey: 'bad' })).rejects.toThrow(
      '401 unauthorized',
    );
  });

  it('rejects if resolveModel ever returns a CustomModel function instead of a LanguageModel', async () => {
    vi.mocked(resolveModel).mockResolvedValue((() => {}) as never);
    await expect(testProviderConnectivity({ provider: 'ollama', model: 'x' })).rejects.toThrow('internal error');
  });

  it('gives a clear, actionable message for an Ollama 403 instead of the raw API error', async () => {
    vi.mocked(resolveModel).mockResolvedValue({ modelId: 'fake' } as never);
    vi.mocked(generateText).mockRejectedValue(
      new APICallError({ message: 'Forbidden', url: 'http://localhost:11434/v1', requestBodyValues: {}, statusCode: 403 }),
    );
    await expect(testProviderConnectivity({ provider: 'ollama', model: 'llama3.2' })).rejects.toThrow(/OLLAMA_ORIGINS/);
  });

  it('gives the same clear API-key-rejected message as Fetch models for a 403 from a non-ollama provider, not the raw API error', async () => {
    vi.mocked(resolveModel).mockResolvedValue({ modelId: 'fake' } as never);
    vi.mocked(generateText).mockRejectedValue(
      new APICallError({ message: 'Forbidden', url: 'https://api.openai.com/v1', requestBodyValues: {}, statusCode: 403 }),
    );
    await expect(testProviderConnectivity({ provider: 'openai', model: 'gpt-5', apiKey: 'bad' })).rejects.toThrow(
      'The API key was not accepted (403).',
    );
  });

  it('gives the same clear message for a 401', async () => {
    vi.mocked(resolveModel).mockResolvedValue({ modelId: 'fake' } as never);
    vi.mocked(generateText).mockRejectedValue(
      new APICallError({ message: 'Unauthorized', url: 'https://api.openai.com/v1', requestBodyValues: {}, statusCode: 401 }),
    );
    await expect(testProviderConnectivity({ provider: 'openai', model: 'gpt-5', apiKey: 'bad' })).rejects.toThrow(
      'The API key was not accepted (401).',
    );
  });

  it('does not rewrite an ollama APICallError with a different status code', async () => {
    vi.mocked(resolveModel).mockResolvedValue({ modelId: 'fake' } as never);
    vi.mocked(generateText).mockRejectedValue(
      new APICallError({ message: 'Not Found', url: 'http://localhost:11434/v1', requestBodyValues: {}, statusCode: 404 }),
    );
    await expect(testProviderConnectivity({ provider: 'ollama', model: 'unknown-model' })).rejects.toThrow('Not Found');
  });
});
