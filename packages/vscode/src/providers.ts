/**
 * Provider factories, imported statically. @asksql/core's resolveModel() uses a
 * dynamic import specifier, which esbuild cannot analyse, and a packaged .vsix
 * ships no node_modules to fall back on - so the factories are imported here
 * statically and the construction mirrors resolveModel exactly.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { PROVIDER_API_HOST, type ModelLike } from '@asksql/core';
import { UserFacingError } from './errors.js';

export type ProviderName = 'ollama' | 'openai' | 'anthropic' | 'google' | 'groq' | 'nvidia' | 'openai-compatible';

export interface ProviderOptions {
  readonly provider: ProviderName;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
}

const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');

/**
 * Link-local range (169.254.0.0/16), which includes the cloud instance-metadata
 * address that can return instance credentials - never a legitimate model
 * endpoint. URL.hostname brackets IPv6 hosts, so strip the brackets before testing.
 */
const isLinkLocal = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6 reaches the mapped IPv4 address; unwrap before testing.
  // URL serializes ::ffff:169.254.x.x as hex groups, so ::ffff:a9fe: covers 169.254.0.0/16.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  if (mapped) return isLinkLocal(mapped[1] ?? '');
  return /^169\.254\./.test(h) || /^fe80:/i.test(h) || /^::ffff:a9fe:/i.test(h);
};

/**
 * Validate at config time so a bad URL is not reported as a provider outage.
 *
 * Never interpolate the URL into the error: a gateway URL can embed credentials
 * (https://user:pass@host/v1) and these messages are shown to the user. Name the
 * setting instead; the value goes to the log channel.
 */
export function assertBaseUrl(url: string, opts?: { readonly carriesSecret?: boolean }): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserFacingError('The base URL is not a valid URL. Check the asksql.baseURL setting.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UserFacingError('The base URL must start with http:// or https://. Check the asksql.baseURL setting.');
  }
  if (!parsed.hostname) throw new UserFacingError('The base URL has no host. Check the asksql.baseURL setting.');
  if (parsed.username || parsed.password) {
    throw new UserFacingError(
      'Remove the user name or password from the base URL. Set the API key with "AskSQL: Set AI Provider API Key" instead.',
    );
  }
  if (isLinkLocal(parsed.hostname)) {
    throw new UserFacingError('That base URL points at a link-local address, which is not a model endpoint.');
  }
  // Sending a key over plaintext hands it to anyone on the path. Loopback is
  // exempt: that is Ollama / LM Studio on the user's own machine.
  if (opts?.carriesSecret && parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
    throw new UserFacingError(
      'Refusing to send your API key over http to a remote host. Use https, or clear the key for a local endpoint.',
    );
  }
}

export function buildModel(opts: ProviderOptions): ModelLike {
  const { provider, model, apiKey, baseURL } = opts;
  // An override on a hosted provider is still an endpoint the key gets sent to,
  // so it gets the same checks as openai-compatible.
  if (baseURL) assertBaseUrl(baseURL, { carriesSecret: Boolean(apiKey) });
  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })(model) as ModelLike;
    case 'anthropic':
      return createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })(model) as ModelLike;
    case 'google':
      return createGoogleGenerativeAI({ apiKey, ...(baseURL ? { baseURL } : {}) })(model) as ModelLike;
    case 'groq':
      return createGroq({ apiKey, ...(baseURL ? { baseURL } : {}) })(model) as ModelLike;
    case 'nvidia':
    case 'ollama':
    case 'openai-compatible': {
      // NVIDIA and Ollama are OpenAI-compatible with a pre-seeded official host;
      // a user-set asksql.baseURL overrides it. openai-compatible has no default.
      const url = baseURL || PROVIDER_API_HOST[provider];
      if (!url) throw new UserFacingError('The OpenAI-compatible provider needs a base URL (set asksql.baseURL).');
      assertBaseUrl(url, { carriesSecret: Boolean(apiKey) });
      return createOpenAICompatible({
        name: provider,
        baseURL: url,
        apiKey: apiKey ?? 'not-required',
      })(model) as ModelLike;
    }
    default:
      throw new UserFacingError(`Unknown AI provider "${String(provider)}".`);
  }
}
