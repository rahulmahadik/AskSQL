import { describe, expect, it } from 'vitest';
import { providerOrigin } from '../src/providerOrigin.js';

describe('providerOrigin', () => {
  it('prefers an explicit baseURL override', () => {
    expect(providerOrigin({ provider: 'ollama', baseURL: 'http://localhost:9999/v1' })).toBe(
      'http://localhost:9999/v1',
    );
  });

  it('falls back to the known default host for a cloud provider', () => {
    expect(providerOrigin({ provider: 'groq' })).toBe('https://api.groq.com/openai/v1');
  });

  it('falls back to the ollama default host when no override is set', () => {
    expect(providerOrigin({ provider: 'ollama' })).toBe('http://localhost:11434/v1');
  });

  it('is undefined for a provider with no fixed host and no override (azure, openai-compatible)', () => {
    expect(providerOrigin({ provider: 'azure' })).toBeUndefined();
    expect(providerOrigin({ provider: 'openai-compatible' })).toBeUndefined();
  });
});
