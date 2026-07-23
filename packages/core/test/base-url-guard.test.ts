import { describe, expect, it } from 'vitest';
import { assertBaseUrl, toIpv4OrNull } from '../src/providers.js';

/** The base URL is user-supplied and fetched with the API key attached, so it is a real SSRF and key-leak surface. */
describe('assertBaseUrl SSRF', () => {
  const blocked = (url: string, carriesSecret = false) => expect(() => assertBaseUrl(url, carriesSecret)).toThrow();

  it('blocks link-local in every inet_aton encoding', () => {
    blocked('http://169.254.169.254/latest/meta-data/');
    blocked('http://2852039166/latest/meta-data/'); // decimal
    blocked('http://0xA9FEA9FE/'); // hex
    blocked('http://0251.0376.0251.0376/'); // octal
    blocked('http://169.16689662/'); // two-part
    blocked('http://[::ffff:169.254.169.254]/'); // ipv4-mapped ipv6 (dotted)
    blocked('http://[::169.254.169.254]/'); // ipv4-mapped ipv6, no ffff
  });

  it('normalizes every encoding to the same dotted quad', () => {
    expect(toIpv4OrNull('2852039166')).toBe('169.254.169.254');
    expect(toIpv4OrNull('0xA9FEA9FE')).toBe('169.254.169.254');
    expect(toIpv4OrNull('169.254.169.254')).toBe('169.254.169.254');
    expect(toIpv4OrNull('2130706433')).toBe('127.0.0.1');
  });

  it('does not mistake a hostname for a numeric address', () => {
    expect(toIpv4OrNull('api.openai.com')).toBeNull();
    expect(toIpv4OrNull('localhost')).toBeNull();
    expect(toIpv4OrNull('999.1.1.1')).toBeNull();
  });

  it('allows ordinary and private-network endpoints', () => {
    expect(() => assertBaseUrl('https://api.openai.com/v1', true)).not.toThrow();
    expect(() => assertBaseUrl('http://localhost:11434/v1', true)).not.toThrow();
    expect(() => assertBaseUrl('http://127.0.0.1:11434/v1', true)).not.toThrow();
    expect(() => assertBaseUrl('https://10.0.0.5/v1', true)).not.toThrow();
    expect(() => assertBaseUrl('https://192.168.1.20/v1', true)).not.toThrow();
  });

  it('refuses a key over plaintext to a remote host and embedded credentials', () => {
    blocked('http://api.example.com/v1', true);
    blocked('https://user:pass@gateway.example.com/v1');
  });

  it('never echoes the raw URL (it can embed a password)', () => {
    try {
      assertBaseUrl('https://user:hunter2@gateway.example.com/v1', false);
    } catch (e) {
      expect((e as { userMessage?: string }).userMessage ?? '').not.toContain('hunter2');
    }
  });
});
