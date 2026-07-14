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
]);

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

function assertBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: `invalid baseURL: ${url}`,
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
  if (CLOUD_PROVIDERS.has(config.provider) && !config.apiKey) {
    throw new AskSqlError('CONFIG_ERROR', {
      detail: `${config.provider} requires apiKey`,
      userMessage: 'The AI provider needs an API key. Add it to your AskSQL configuration.',
    });
  }
  if (config.baseURL) assertBaseUrl(config.baseURL);

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
      return create({ apiKey: config.apiKey })(config.model);
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
    case 'ollama':
    case 'openai-compatible': {
      const mod = await importProvider('@ai-sdk/openai-compatible');
      const create = mod['createOpenAICompatible'] as (o: object) => (id: string) => ModelLike;
      const baseURL = config.baseURL ?? (config.provider === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : undefined);
      if (!baseURL) {
        throw new AskSqlError('CONFIG_ERROR', {
          detail: 'openai-compatible requires baseURL',
          userMessage: 'The OpenAI-compatible provider needs a base URL.',
        });
      }
      assertBaseUrl(baseURL);
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
