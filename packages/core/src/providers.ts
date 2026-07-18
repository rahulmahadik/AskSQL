/**
 * Provider resolution: a config object -> an AI SDK
 * LanguageModel. Provider packages are optional peers, dynamically
 * imported with actionable install errors - a MySQL-only user never
 * downloads Anthropic bytes and vice versa.
 *
 * No model IDs are hardcoded anywhere in core.
 */

import { AskSqlError } from './errors.js';
import type { ModelLike } from './types.js';

export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure'
  | 'groq'
  | 'nvidia'
  | 'ollama'
  | 'openai-compatible';

export interface ProviderConfig {
  readonly provider: ProviderName;
  /** Model identifier, e.g. "llama-3.3-70b-versatile". Required. */
  readonly model: string;
  readonly apiKey?: string;
  /** Base URL for ollama / openai-compatible (LM Studio, vLLM, OpenRouter...). */
  readonly baseURL?: string;
  /** Azure resource name (when not using baseURL). */
  readonly resourceName?: string;
  readonly headers?: Record<string, string>;
}

const CLOUD_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  'openai',
  'anthropic',
  'google',
  'azure',
  'groq',
  'nvidia',
]);

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/**
 * Pre-seeded official API host for every provider (user `baseURL` always overrides).
 * `nvidia`/`ollama` are built with createOpenAICompatible, so their host is used for
 * construction too; the dedicated SDK providers (openai/anthropic/google/groq) carry
 * their own URL, so their host here is used only for model listing, display, and as
 * the value a user overrides. `azure` (resource-specific) and `openai-compatible`
 * (fully user-supplied) have no fixed host.
 */
export const PROVIDER_API_HOST: Readonly<Record<ProviderName, string | undefined>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  azure: undefined,
  groq: 'https://api.groq.com/openai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  ollama: OLLAMA_DEFAULT_BASE_URL,
  'openai-compatible': undefined,
};

const isLoopback = (h: string): boolean =>
  h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');

/** Link-local range (169.254.0.0/16), which includes the cloud instance-metadata address. */
const isLinkLocal = (h: string): boolean => /^169\.254\./.test(h) || /^fe80:/i.test(h) || h === '[fe80::]';

/**
 * Validate a user-supplied AI endpoint URL. Never interpolate the raw URL into an
 * error (it may embed credentials). When `carriesSecret`, refuse plaintext http to
 * a remote host and link-local/metadata hosts, so an API key cannot be exfiltrated.
 */
function assertBaseUrl(url: string, carriesSecret: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'baseURL is not a valid URL',
      userMessage: 'The AI endpoint URL is not a valid URL.',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: `unsupported protocol: ${parsed.protocol}`,
      userMessage: 'The AI endpoint URL must start with http:// or https://.',
    });
  }
  if (!parsed.hostname) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'baseURL has no hostname',
      userMessage: 'The AI endpoint URL has no host.',
    });
  }
  if (isLinkLocal(parsed.hostname)) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'baseURL points at a link-local address',
      userMessage: 'That AI endpoint address is not allowed.',
    });
  }
  if (carriesSecret && parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'refusing to send apiKey over http to a remote host',
      userMessage: 'Refusing to send the API key over http to a remote host. Use https, or a local endpoint.',
    });
  }
}

async function importProvider(pkgName: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pkgName)) as Record<string, unknown>;
  } catch (err) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: `cannot import ${pkgName}: ${err instanceof Error ? err.message : String(err)}`,
      userMessage: `The AI provider package is not installed. Run: npm install ${pkgName}`,
      cause: err,
    });
  }
}

/** Resolve a provider config into an AI SDK LanguageModel instance. */
export async function resolveModel(config: ProviderConfig): Promise<ModelLike> {
  if (!config.model || config.model.trim().length === 0) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: 'ProviderConfig.model is empty',
      userMessage: 'No AI model is configured. Set a model name in your AskSQL configuration.',
    });
  }
  if (CLOUD_PROVIDERS.has(config.provider) && !config.apiKey?.trim()) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: `${config.provider} requires apiKey`,
      userMessage: 'The AI provider needs an API key. Add it to your AskSQL configuration.',
    });
  }
  if (config.baseURL) assertBaseUrl(config.baseURL, Boolean(config.apiKey));

  switch (config.provider) {
    case 'openai': {
      const mod = await importProvider('@ai-sdk/openai');
      const create = mod['createOpenAI'] as (o: object) => (id: string) => ModelLike;
      return create({ apiKey: config.apiKey,...(config.baseURL ? { baseURL: config.baseURL } : {}) })(config.model);
    }
    case 'anthropic': {
      const mod = await importProvider('@ai-sdk/anthropic');
      const create = mod['createAnthropic'] as (o: object) => (id: string) => ModelLike;
      return create({ apiKey: config.apiKey,...(config.baseURL ? { baseURL: config.baseURL } : {}) })(config.model);
    }
    case 'google': {
      const mod = await importProvider('@ai-sdk/google');
      const create = mod['createGoogleGenerativeAI'] as (o: object) => (id: string) => ModelLike;
      // Honor a user-supplied baseURL instead of silently sending the key to the
      // vendor cloud (assertBaseUrl above already validated it).
      return create({ apiKey: config.apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })(config.model);
    }
    case 'azure': {
      // Fail at config time, not mid-request: without either setting, the SDK
      // throws a lazy load error that reads like a transient provider fault.
      if (!config.resourceName && !config.baseURL) {
        throw new AskSqlError('CONFIG_ERROR', {
          detail: 'azure requires resourceName or baseURL',
          userMessage:
            'Azure needs the resource name from your endpoint (https://<resource>.openai.azure.com) or a full baseURL. For Azure AI Foundry endpoints (*.services.ai.azure.com), use the openai provider with a baseURL instead.',
        });
      }
      // resourceName is interpolated into https://<resourceName>.openai.azure.com,
      // so restrict it to the characters Azure actually allows in a resource name.
      if (config.resourceName && !/^[A-Za-z0-9][A-Za-z0-9-]{1,62}[A-Za-z0-9]$/.test(config.resourceName)) {
        throw new AskSqlError('CONFIG_ERROR', {
          detail: 'invalid azure resourceName',
          userMessage: 'The Azure resource name contains invalid characters.',
        });
      }
      const mod = await importProvider('@ai-sdk/azure');
      const create = mod['createAzure'] as (o: object) => (id: string) => ModelLike;
      return create({
        apiKey: config.apiKey,
        ...(config.resourceName ? { resourceName: config.resourceName } : {}),
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      })(config.model);
    }
    case 'groq': {
      const mod = await importProvider('@ai-sdk/groq');
      const create = mod['createGroq'] as (o: object) => (id: string) => ModelLike;
      return create({ apiKey: config.apiKey })(config.model);
    }
    case 'nvidia':
    case 'ollama':
    case 'openai-compatible': {
      // NVIDIA and Ollama are OpenAI-compatible with a known endpoint we pre-seed;
      // a user-supplied baseURL overrides it. openai-compatible has no default.
      const mod = await importProvider('@ai-sdk/openai-compatible');
      const create = mod['createOpenAICompatible'] as (o: object) => (id: string) => ModelLike;
      const baseURL = config.baseURL ?? PROVIDER_API_HOST[config.provider];
      if (!baseURL) {
        throw new AskSqlError('CONFIG_ERROR', {
          detail: 'openai-compatible requires baseURL',
          userMessage: 'The OpenAI-compatible provider needs a base URL.',
        });
      }
      assertBaseUrl(baseURL, Boolean(config.apiKey));
      return create({
        name: config.provider,
        baseURL,
        apiKey: config.apiKey ?? 'not-required',
        ...(config.headers ? { headers: config.headers } : {}),
      })(config.model);
    }
    default: {
      throw new AskSqlError('CONFIG_ERROR', {
        detail: `unknown provider: ${String(config.provider)}`,
        userMessage: 'Unknown AI provider in configuration.',
      });
    }
  }
}
