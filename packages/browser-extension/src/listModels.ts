/**
 * "Fetch models" - discover models from the user's own endpoint instead of a
 * free-text guess: Ollama via GET {root}/api/tags, OpenAI-compatible/hosted
 * providers with a listable endpoint via GET {baseURL}/models. See
 * packages/vscode/src/models.ts for the equivalent in the VS Code extension.
 */
import { assertBaseUrl, PROVIDER_API_HOST, type ProviderName } from '@asksql/core';
import { permissionDeniedMessage } from './originAccess.js';
import { ensureProviderOriginAccess } from './providerAccess.js';

const LISTABLE_HOSTED: ReadonlySet<ProviderName> = new Set(['openai', 'groq', 'nvidia']);
const MODEL_LOOKUP_TIMEOUT_MS = 10_000;

const isEmbedding = (name: string): boolean => /embed|embedding/i.test(name);

/** The endpoint we can list models from, if any (anthropic/google/azure have no such listing). */
export function listableBaseUrl(provider: ProviderName, configuredBaseURL: string | undefined): string | undefined {
  if (provider === 'ollama') return configuredBaseURL || 'http://localhost:11434/v1';
  if (provider === 'openai-compatible') return configuredBaseURL || undefined;
  if (LISTABLE_HOSTED.has(provider)) return configuredBaseURL || PROVIDER_API_HOST[provider];
  return undefined;
}

export class ModelListError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelListError';
  }
}

/** Ollama's own origin allowlist rejects the extension unless OLLAMA_ORIGINS covers it - a 403 here is that, not a wrong URL. */
function isLikelyOllamaOriginBlock(status: number): boolean {
  return status === 403;
}

/** A 200 with a body that isn't the JSON this module expects (e.g. a proxy's HTML error page) is a real problem, not "no models found." */
async function parseJsonOrThrow(res: Response, endpointLabel: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ModelListError(`${endpointLabel} responded, but not with a model list AskSQL understands. Is that the right URL?`, res.status);
  }
}

async function listOllama(baseURL: string, signal: AbortSignal): Promise<string[]> {
  assertBaseUrl(baseURL, false);
  const root = baseURL.replace(/\/v1\/?$/, ''); // baseURL is the OpenAI-compatible path; /api/tags sits at the root
  const res = await fetch(`${root}/api/tags`, { signal });
  if (!res.ok) {
    if (isLikelyOllamaOriginBlock(res.status)) {
      throw new ModelListError(
        `Ollama refused this request (${res.status} Forbidden) - it doesn't allow the extension's origin by default. ` +
          `Restart Ollama with OLLAMA_ORIGINS=chrome-extension://* (or your extension's exact id) set, then try again.`,
        res.status,
      );
    }
    throw new ModelListError(`Ollama replied ${res.status}. Is it running at ${root}?`, res.status);
  }
  const body = (await parseJsonOrThrow(res, `Ollama (${root})`)) as { models?: { name?: string }[] };
  return (body.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n && !isEmbedding(n)));
}

async function listOpenAICompatible(baseURL: string, apiKey: string | undefined, signal: AbortSignal): Promise<string[]> {
  assertBaseUrl(baseURL, Boolean(apiKey));
  const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal,
  });
  if (!res.ok) {
    const msg = res.status === 401 || res.status === 403 ? `The API key was not accepted (${res.status}).` : `The endpoint replied ${res.status}.`;
    throw new ModelListError(msg, res.status);
  }
  const body = (await parseJsonOrThrow(res, baseURL)) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id && !isEmbedding(id)));
}

/** Models at the provider's own endpoint, or `[]` if that provider has no listable endpoint (anthropic/google/azure). */
export async function fetchProviderModels(
  provider: ProviderName,
  baseURL: string | undefined,
  apiKey: string | undefined,
): Promise<string[]> {
  const listable = listableBaseUrl(provider, baseURL);
  if (!listable) return [];
  if (!(await ensureProviderOriginAccess(listable))) {
    throw new ModelListError(permissionDeniedMessage(listable));
  }
  const signal = AbortSignal.timeout(MODEL_LOOKUP_TIMEOUT_MS);
  return provider === 'ollama' ? listOllama(listable, signal) : listOpenAICompatible(listable, apiKey, signal);
}
