/**
 * resolveModel configuration validation. These paths throw before any provider
 * SDK is imported, so no @ai-sdk/* package needs to be installed to run them.
 */
import { describe, expect, it } from 'vitest';
import { resolveModel } from '../src/providers.js';

const err = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'CONFIG_ERROR' });

describe('resolveModel validation', () => {
  it('rejects an empty model id', () => err(resolveModel({ provider: 'openai', model: '  ', apiKey: 'k' })));

  it('requires an apiKey for cloud providers', () => {
    return err(resolveModel({ provider: 'openai', model: 'gpt-4o' }));
  });

  it('resolves ollama with no apiKey (defaults to the local endpoint)', async () => {
    const m = await resolveModel({ provider: 'ollama', model: 'llama3' });
    expect(m).toBeTruthy();
  });

  it('rejects an invalid AI endpoint URL before importing anything', () =>
    err(resolveModel({ provider: 'openai', model: 'm', apiKey: 'k', baseURL: 'not a url' })));

  it('blocks a link-local AI endpoint (SSRF) even with a valid model', () =>
    err(resolveModel({ provider: 'openai', model: 'm', apiKey: 'k', baseURL: 'http://169.254.169.254/v1' })));

  it('azure requires resourceName or baseURL', () => err(resolveModel({ provider: 'azure', model: 'm', apiKey: 'k' })));

  it('azure rejects an invalid resource name', () =>
    err(resolveModel({ provider: 'azure', model: 'm', apiKey: 'k', resourceName: 'bad name!' })));

  it('openai-compatible requires a base URL', () =>
    err(resolveModel({ provider: 'openai-compatible', model: 'm', apiKey: 'k' })));

  it('rejects an unknown provider', () =>
    err(resolveModel({ provider: 'made-up' as 'openai', model: 'm', apiKey: 'k' })));
});

describe('resolveModel provider construction', () => {
  // The @ai-sdk/* peers are installed in this workspace, so each arm builds a model.
  it('builds an openai model', async () => {
    expect(await resolveModel({ provider: 'openai', model: 'gpt-4o', apiKey: 'k' })).toBeTruthy();
  });
  it('builds an anthropic model', async () => {
    expect(await resolveModel({ provider: 'anthropic', model: 'claude-3', apiKey: 'k' })).toBeTruthy();
  });
  it('builds a google model, honoring a user baseURL', async () => {
    expect(
      await resolveModel({ provider: 'google', model: 'gemini', apiKey: 'k', baseURL: 'https://gw.example/v1' }),
    ).toBeTruthy();
  });
  it('builds a groq model', async () => {
    expect(await resolveModel({ provider: 'groq', model: 'llama-3.3-70b', apiKey: 'k' })).toBeTruthy();
  });
  it('builds an azure model from a resource name', async () => {
    expect(
      await resolveModel({ provider: 'azure', model: 'gpt-4o', apiKey: 'k', resourceName: 'myresource' }),
    ).toBeTruthy();
  });
  it('builds nvidia from its pre-seeded endpoint', async () => {
    expect(await resolveModel({ provider: 'nvidia', model: 'nemotron', apiKey: 'k' })).toBeTruthy();
  });
  it('builds an openai-compatible model with a baseURL and custom headers', async () => {
    expect(
      await resolveModel({
        provider: 'openai-compatible',
        model: 'm',
        apiKey: 'k',
        baseURL: 'https://api.example/v1',
        headers: { 'X-Extra': '1' },
      }),
    ).toBeTruthy();
  });
});
