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
import { assertBaseUrl, type ProviderName } from './providers.js';
import { OLLAMA_DEFAULT_BASE_URL, MODEL_LOOKUP_TIMEOUT_MS } from './constants.js';
import { apiKeyKey } from './engine.js';
import { UserFacingError, userMessage } from './errors.js';

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
  return undefined; // hosted SDKs own their endpoint
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

/** Switch provider, then offer its models - the two always change together. */
export async function selectProvider(secrets: vscode.SecretStorage): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('asksql');
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'ollama', description: 'local, no API key needed' },
      { label: 'openai', description: 'needs an API key' },
      { label: 'anthropic', description: 'needs an API key' },
      { label: 'google', description: 'needs an API key' },
      { label: 'groq', description: 'needs an API key' },
      { label: 'openai-compatible', description: 'any other LLM: LM Studio, vLLM, OpenRouter, Together, a gateway...' },
    ],
    { placeHolder: `AI provider (current: ${cfg.get<string>('provider') ?? 'ollama'})`, ignoreFocusOut: true },
  );
  if (!picked) return false;
  await cfg.update('provider', picked.label, vscode.ConfigurationTarget.Global);

  // openai-compatible is useless without an endpoint, so ask right away.
  if (picked.label === 'openai-compatible' && !cfg.get<string>('baseURL')) {
    const url = await vscode.window.showInputBox({
      prompt: 'Base URL of your OpenAI-compatible endpoint',
      placeHolder: 'https://your-endpoint/v1',
      ignoreFocusOut: true,
    });
    if (url) await cfg.update('baseURL', url, vscode.ConfigurationTarget.Global);
  }
  await selectModel(secrets);
  return true;
}
