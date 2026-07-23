import { describe, it, expect } from 'vitest';
import {
  OLLAMA_DEFAULT_BASE_URL,
  DEFAULT_PORT,
  CONNECT_TIMEOUT_MS,
  MODEL_LOOKUP_TIMEOUT_MS,
  LM_LIST_TIMEOUT_MS,
  PROVIDER_TEST_TIMEOUT_MS,
} from '../src/constants.js';

describe('constants', () => {
  it('exposes the Ollama default endpoint', () => {
    expect(OLLAMA_DEFAULT_BASE_URL).toBe('http://localhost:11434/v1');
  });

  it('has default ports for the port-based engines', () => {
    expect(DEFAULT_PORT).toEqual({ postgres: 5432, mysql: 3306, oracle: 1521 });
  });

  it('has positive, sane timeout ceilings', () => {
    for (const ms of [CONNECT_TIMEOUT_MS, MODEL_LOOKUP_TIMEOUT_MS, LM_LIST_TIMEOUT_MS, PROVIDER_TEST_TIMEOUT_MS]) {
      expect(ms).toBeGreaterThan(0);
    }
    expect(PROVIDER_TEST_TIMEOUT_MS).toBeGreaterThan(MODEL_LOOKUP_TIMEOUT_MS);
  });
});
