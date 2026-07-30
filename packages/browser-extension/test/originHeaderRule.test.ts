import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProviderOriginStripRule, syncProviderOriginStripRule } from '../src/originHeaderRule.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';

interface StripRule {
  id: number;
  action: { type: string; requestHeaders: { header: string; operation: string }[] };
  condition: { requestDomains: string[]; resourceTypes: string[] };
}

const firstRule = (mock: ChromeMock) => [...mock.dynamicRules.values()][0] as StripRule;

describe('syncProviderOriginStripRule', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  it("removes the Origin header for the provider host, for the request type an LLM call uses", async () => {
    await syncProviderOriginStripRule('http://localhost:11434/v1');

    expect(mock.dynamicRules.size).toBe(1);
    const rule = firstRule(mock);
    expect(rule.action.type).toBe('modifyHeaders');
    expect(rule.action.requestHeaders).toEqual([{ header: 'origin', operation: 'remove' }]);
    expect(rule.condition.requestDomains).toEqual(['localhost']);
    expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest']);
  });

  it('scopes the rule to the provider host only, never all hosts', async () => {
    await syncProviderOriginStripRule('https://api.groq.com/openai/v1');
    expect(firstRule(mock).condition.requestDomains).toEqual(['api.groq.com']);
  });

  it('replaces the rule rather than accumulating one per provider ever configured', async () => {
    await syncProviderOriginStripRule('http://localhost:11434/v1');
    await syncProviderOriginStripRule('https://api.example.com/v1');

    expect(mock.dynamicRules.size).toBe(1);
    expect(firstRule(mock).condition.requestDomains).toEqual(['api.example.com']);
  });

  it('clears the rule when given undefined', async () => {
    await syncProviderOriginStripRule('http://localhost:11434/v1');
    await syncProviderOriginStripRule(undefined);
    expect(mock.dynamicRules.size).toBe(0);
  });

  it('clearProviderOriginStripRule removes it', async () => {
    await syncProviderOriginStripRule('http://localhost:11434/v1');
    await clearProviderOriginStripRule();
    expect(mock.dynamicRules.size).toBe(0);
  });

  it('warns but does not throw when the API is unavailable, so connecting still proceeds', async () => {
    mock.failNext.updateDynamicRules = true;
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(syncProviderOriginStripRule('http://localhost:11434/v1')).resolves.toBeUndefined();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Origin-strip rule'), expect.any(Error));
  });
});
