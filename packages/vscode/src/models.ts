/**
 * "Select model" - discover models from the user's own endpoint.
 *
 * Deliberately no baked-in model list. Model catalogues change constantly and
 * users bring their own LLM (that is the whole point of the openai-compatible
 * provider), so a hardcoded list would be both stale and wrong for them. We ask
 * the endpoint the user configured:
 *
 *  - ollama            -> GET {root}/api/tags   (its own listing API)
 *  - openai-compatible -> GET {baseURL}/models  (the OpenAI standard, which
 *                         LM Studio, vLLM, OpenRouter, Together, Groq, ... all
 *                         implement)
 *
 * Hosted SDK providers (openai/anthropic/google/groq selected directly) keep
 * their endpoint inside the SDK, so there is nothing for us to query without
 * inventing base URLs - those fall back to typing the id, which is honest.
 */

import * as vscode from 'vscode';
import { PROVIDER_API_HOST } from '@asksql/core';
import { assertBaseUrl, type ProviderName } from './providers.js';
import { OLLAMA_DEFAULT_BASE_URL, MODEL_LOOKUP_TIMEOUT_MS } from './constants.js';
import { apiKeyKey } from './engine.js';
import { UserFacingError, userMessage } from './errors.js';

/** Hosted providers that expose an OpenAI-style /models list we can offer as a picker. */
const LISTABLE_HOSTED: ReadonlySet<ProviderName> = new Set(['openai', 'groq', 'nvidia']);

/**
 * Embedding models are listed next to chat models but cannot write SQL, and
 * picking one fails in a way that looks like AskSQL is broken. The name is the
 * only signal these APIs give us.
 */
const isEmbedding = (name: string): boolean => /embed|embedding/i.test(name);

async function listOllama(baseURL: string, signal: AbortSignal): Promise<string[]> {
  assertBaseUrl(baseURL);
  // baseURL points at the OpenAI-compatible path (/v1); tags sits at the root.
  const root = baseURL.replace(/\/v1\/?$/, '');
  const res = await fetch(`${root}/api/tags`, { signal });
  if (!res.ok) throw new UserFacingError(`Ollama replied ${res.status}. Is it running?`);
  const body = (await res.json()) as { models?: { name?: string }[] };
  return (body.models ?? []).map((m) => m.name).filter((n): n is string => !!n && !isEmbedding(n));
}

async function listOpenAICompatible(baseURL: string, apiKey: string | undefined, signal: AbortSignal): Promise<string[]> {
  // The same checks buildModel applies. Without this, "Select Model" would send
  // the key to an unvalidated host - over plaintext, or to a metadata address -
  // while the query path that DOES validate looks safe.
  assertBaseUrl(baseURL, { carriesSecret: Boolean(apiKey) });
  const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal,
  });
  if (!res.ok) throw new UserFacingError(`The endpoint replied ${res.status}.`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id && !isEmbedding(id));
}

/** The endpoint we can list from, if any. */
function listableBaseUrl(provider: ProviderName, configured: string): string | undefined {
  if (provider === 'ollama') return configured || OLLAMA_DEFAULT_BASE_URL;
  if (provider === 'openai-compatible') return configured || undefined;
  // openai / groq / nvidia expose an OpenAI-style /models list at their official host,
  // so we can offer a real model picker instead of making the user type an id.
  if (LISTABLE_HOSTED.has(provider)) return configured || PROVIDER_API_HOST[provider];
  return undefined; // anthropic / google have no OpenAI-style listing
}

/**
 * The configured provider's own models, when its endpoint can be listed (Ollama /
 * OpenAI-compatible). Empty for hosted SDKs, which own their endpoint. Bounded so a
 * dead endpoint cannot hang the model picker.
 */
export async function providerModels(secrets: vscode.SecretStorage, timeoutMs: number): Promise<string[]> {
  const cfg = vscode.workspace.getConfiguration('asksql');
  const provider = (cfg.get<string>('provider') ?? 'ollama') as ProviderName;
  const baseURL = listableBaseUrl(provider, cfg.get<string>('baseURL') || '');
  if (!baseURL) return [];
  const apiKey = (await secrets.get(apiKeyKey(provider))) ?? undefined;
  const signal = AbortSignal.timeout(timeoutMs);
  return provider === 'ollama' ? listOllama(baseURL, signal) : listOpenAICompatible(baseURL, apiKey, signal);
}

async function typeModelId(provider: string, current: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: `Model id for ${provider}`,
    value: current,
    placeHolder: 'exactly as your provider names it',
    ignoreFocusOut: true,
  });
}

/** Prompt for a model and save it. Returns the chosen id, or undefined if cancelled. */
export async function selectModel(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration('asksql');
  const provider = (cfg.get<string>('provider') ?? 'ollama') as ProviderName;
  const current = cfg.get<string>('model') ?? '';
  const baseURL = listableBaseUrl(provider, cfg.get<string>('baseURL') || '');

  let model: string | undefined;

  if (baseURL) {
    try {
      const apiKey = (await secrets.get(apiKeyKey(provider))) ?? undefined;
      const found = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'AskSQL: looking up available models...',
          // Node's fetch has no default timeout, so an endpoint that blackholes
          // packets (VPN down, wrong port - routine for a self-hosted gateway)
          // would spin this notification forever with no way out but a reload.
          cancellable: true,
        },
        (_progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(MODEL_LOOKUP_TIMEOUT_MS)]);
          return provider === 'ollama'
            ? listOllama(baseURL, signal)
            : listOpenAICompatible(baseURL, apiKey, signal);
        },
      );
      const MANUAL = '$(edit) Enter a model id manually...';
      const picked = await vscode.window.showQuickPick(
        [
          ...found.map((id) => ({ label: id, description: id === current ? 'current' : undefined })),
          { label: MANUAL },
        ],
        {
          placeHolder: found.length
            ? `Model for ${provider}${current ? ` (current: ${current})` : ''}`
            : `No models found at ${baseURL}`,
          ignoreFocusOut: true,
        },
      );
      if (!picked) return undefined;
      model = picked.label === MANUAL ? await typeModelId(provider, current) : picked.label;
    } catch (err) {
      // Never dead-end on a lookup failure - say why, then let them type it.
      const proceed = await vscode.window.showWarningMessage(
        `AskSQL: could not list models. ${userMessage(err)}`,
        'Enter manually',
      );
      if (!proceed) return undefined;
      model = await typeModelId(provider, current);
    }
  } else {
    model = await typeModelId(provider, current);
  }

  if (!model) return undefined;
  // Model choice is machine-level, not project-level.
  await cfg.update('model', model, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`AskSQL: using ${model}.`);
  return model;
}

/** Every provider except Ollama needs an API key. */
const NEEDS_API_KEY = (p: ProviderName): boolean => p !== 'ollama';

/**
 * Prompt for and store a provider's API key. Blank input keeps an existing key
 * (so re-running the flow doesn't force re-entry); a value replaces it. No host
 * strings in the prompt - the webview autolinker would turn them into a live link.
 */
async function promptForApiKey(secrets: vscode.SecretStorage, provider: ProviderName): Promise<void> {
  const existing = await secrets.get(apiKeyKey(provider));
  const key = await vscode.window.showInputBox({
    prompt: existing
      ? `Update the ${provider} API key (leave blank to keep the current one)`
      : `Paste your ${provider} API key - stored in your OS keychain, never in settings`,
    placeHolder: existing ? '' : 'Get it from your provider dashboard',
    password: true,
    ignoreFocusOut: true,
  });
  if (key && key.trim()) await secrets.store(apiKeyKey(provider), key.trim());
}

/**
 * Switch provider, collect what it needs, then offer its models. Answers are
 * gathered BEFORE anything is committed so cancelling never strands a half
 * configuration (e.g. openai-compatible with no base URL). Switching to a hosted
 * provider clears a stale baseURL so its key is never sent to a dead endpoint.
 */
export async function selectProvider(secrets: vscode.SecretStorage): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('asksql');
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'ollama', description: 'Local models, no API key needed' },
      { label: 'openai', description: 'Needs an API key' },
      { label: 'anthropic', description: 'Needs an API key' },
      { label: 'google', description: 'Needs an API key' },
      { label: 'groq', description: 'Fast, generous free tier - needs an API key' },
      { label: 'nvidia', description: 'Free tier with many open models - needs an API key' },
      { label: 'openai-compatible', description: 'Any other LLM: LM Studio, vLLM, OpenRouter, Together, a gateway...' },
    ],
    { placeHolder: `AI provider (current: ${cfg.get<string>('provider') ?? 'ollama'})`, ignoreFocusOut: true },
  );
  if (!picked) return false;
  const provider = picked.label as ProviderName;

  // openai-compatible has no pre-seeded endpoint; collect it before committing so a
  // cancel here doesn't leave the provider set with nowhere to send requests.
  let baseURL: string | undefined;
  if (provider === 'openai-compatible') {
    baseURL = cfg.get<string>('baseURL') || undefined;
    if (!baseURL) {
      const url = await vscode.window.showInputBox({
        prompt: 'Base URL of your OpenAI-compatible endpoint',
        placeHolder: 'https://your-endpoint/v1',
        ignoreFocusOut: true,
      });
      if (!url) return false; // cancelled - don't commit a provider it can't reach
      baseURL = url;
    }
  }

  await cfg.update('provider', provider, vscode.ConfigurationTarget.Global);
  if (provider === 'openai-compatible') {
    if (baseURL && baseURL !== cfg.get<string>('baseURL')) {
      await cfg.update('baseURL', baseURL, vscode.ConfigurationTarget.Global);
    }
  } else if (provider !== 'ollama' && cfg.get<string>('baseURL')) {
    // Hosted providers use their official host; drop a leftover override so the key
    // isn't sent to whatever endpoint the previous provider pointed at.
    await cfg.update('baseURL', undefined, vscode.ConfigurationTarget.Global);
  }

  // The step that was missing: actually ask for the key when the provider needs one.
  if (NEEDS_API_KEY(provider)) await promptForApiKey(secrets, provider);

  await selectModel(secrets);
  return true;
}
