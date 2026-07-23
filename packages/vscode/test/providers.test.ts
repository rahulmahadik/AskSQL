import { describe, it, expect, vi } from 'vitest';

// Provider factories are stubbed so buildModel wiring can be asserted without
// constructing a real SDK client. Each factory returns a function that returns
// a tagged object, so we can read back exactly what was passed.
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((opts: unknown) => (model: string) => ({ tag: 'openai', opts, model })),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn((opts: unknown) => (model: string) => ({ tag: 'anthropic', opts, model })),
}));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn((opts: unknown) => (model: string) => ({ tag: 'google', opts, model })),
}));
vi.mock('@ai-sdk/groq', () => ({
  createGroq: vi.fn((opts: unknown) => (model: string) => ({ tag: 'groq', opts, model })),
}));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((opts: unknown) => (model: string) => ({ tag: 'compat', opts, model })),
}));

import { buildModel, assertBaseUrl } from '../src/providers.js';
import { UserFacingError } from '../src/errors.js';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

describe('assertBaseUrl', () => {
  it('accepts valid http and https URLs', () => {
    expect(() => assertBaseUrl('https://api.example.com/v1')).not.toThrow();
    expect(() => assertBaseUrl('http://localhost:11434/v1')).not.toThrow();
  });

  it('rejects an unparseable URL', () => {
    expect(() => assertBaseUrl('not a url')).toThrow(UserFacingError);
  });

  it('rejects a non-http(s) protocol', () => {
    expect(() => assertBaseUrl('ftp://example.com')).toThrow(/http:\/\/ or https:\/\//);
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => assertBaseUrl('https://user:pass@example.com/v1')).toThrow(/Remove the user name or password/);
  });

  it('rejects a link-local IPv4 metadata address', () => {
    expect(() => assertBaseUrl('http://169.254.169.254/latest')).toThrow(/link-local address/);
  });

  it('rejects an IPv4-mapped IPv6 metadata address', () => {
    expect(() => assertBaseUrl('http://[::ffff:169.254.169.254]/')).toThrow(/link-local address/);
  });

  it('rejects fe80: link-local IPv6', () => {
    expect(() => assertBaseUrl('http://[fe80::1]/v1')).toThrow(/link-local address/);
  });

  it('refuses to send a secret over http to a remote host', () => {
    expect(() => assertBaseUrl('http://api.example.com/v1', { carriesSecret: true })).toThrow(
      /Refusing to send your API key over http/,
    );
  });

  it('allows a secret over http to loopback (local Ollama / LM Studio)', () => {
    expect(() => assertBaseUrl('http://localhost:1234/v1', { carriesSecret: true })).not.toThrow();
    expect(() => assertBaseUrl('http://127.0.0.1:1234/v1', { carriesSecret: true })).not.toThrow();
  });

  it('allows a secret over https to a remote host', () => {
    expect(() => assertBaseUrl('https://api.example.com/v1', { carriesSecret: true })).not.toThrow();
  });
});

describe('buildModel', () => {
  it('wires the OpenAI factory with apiKey and model', () => {
    const m = buildModel({ provider: 'openai', model: 'gpt-x', apiKey: 'k' }) as { tag: string; model: string };
    expect(m.tag).toBe('openai');
    expect(m.model).toBe('gpt-x');
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'k' });
  });

  it('passes a baseURL override through to the hosted factory', () => {
    buildModel({ provider: 'anthropic', model: 'claude', apiKey: 'k', baseURL: 'https://gw.example.com/v1' });
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'k', baseURL: 'https://gw.example.com/v1' });
  });

  it('wires groq', () => {
    const m = buildModel({ provider: 'groq', model: 'llama', apiKey: 'k' }) as { tag: string };
    expect(m.tag).toBe('groq');
    expect(createGroq).toHaveBeenCalled();
  });

  it('routes ollama through the OpenAI-compatible factory at its default host', () => {
    const m = buildModel({ provider: 'ollama', model: 'qwen' }) as { tag: string; opts: { baseURL: string } };
    expect(m.tag).toBe('compat');
    expect(m.opts.baseURL).toBe('http://localhost:11434/v1');
    expect(createOpenAICompatible).toHaveBeenCalled();
  });

  it('routes nvidia through the compatible factory at its official host', () => {
    const m = buildModel({ provider: 'nvidia', model: 'x', apiKey: 'k' }) as { opts: { baseURL: string } };
    expect(m.opts.baseURL).toBe('https://integrate.api.nvidia.com/v1');
  });

  it('defaults the openai-compatible api key to a placeholder when none is set', () => {
    const m = buildModel({ provider: 'openai-compatible', model: 'x', baseURL: 'https://c.example.com/v1' }) as {
      opts: { apiKey: string };
    };
    expect(m.opts.apiKey).toBe('not-required');
  });

  it('requires a base URL for openai-compatible', () => {
    expect(() => buildModel({ provider: 'openai-compatible', model: 'x' })).toThrow(/needs a base URL/);
  });

  it('validates a bad baseURL override before building', () => {
    expect(() => buildModel({ provider: 'openai', model: 'x', apiKey: 'k', baseURL: 'nonsense' })).toThrow(
      UserFacingError,
    );
  });

  it('rejects an unknown provider', () => {
    expect(() => buildModel({ provider: 'mystery' as never, model: 'x' })).toThrow(/Unknown AI provider/);
  });
});
