/**
 * LLM call plumbing: streaming, overall timeout, bounded jittered retries honoring retry-after,
 * AbortSignal propagation, and mapping of provider failures onto the AskSQL error taxonomy.
 * Every call has an explicit timeout - never a transport default.
 */

import { streamText } from 'ai';
import { AskSqlError } from './errors.js';
import type { CustomModel, LlmSettings, LlmUsage, ModelLike } from './types.js';

export interface LlmCallInput {
  readonly model: ModelLike;
  readonly system: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly settings?: LlmSettings;
  readonly onToken?: (text: string) => void;
}

export interface LlmCallResult {
  readonly text: string;
  readonly usage: LlmUsage;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

// Reasoning models (OpenAI o-series, GPT-5 family) reject an explicit `temperature`; "-chat" variants keep it.
const REASONING_MODEL_RE = /(?:^|[/:])(o[1-9](?:$|[-.\d])|gpt-5)/i;

function isReasoningModelId(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return REASONING_MODEL_RE.test(modelId) && !/chat/i.test(modelId);
}

/**
 * Map {@link LlmSettings} onto the sampling options a `streamText` call understands. Unset fields
 * are omitted entirely; `temperature` defaults to 0 and is dropped for reasoning models.
 */
export function buildLlmRequestOptions(
  s?: LlmSettings,
  modelId?: string,
  omitTemperature = false,
): Record<string, unknown> {
  const dropTemperature = omitTemperature || isReasoningModelId(modelId);
  return {
    ...(dropTemperature ? {} : { temperature: s?.temperature ?? 0 }),
    ...(s?.topP !== undefined ? { topP: s.topP } : {}),
    ...(s?.topK !== undefined ? { topK: s.topK } : {}),
    ...(s?.frequencyPenalty !== undefined ? { frequencyPenalty: s.frequencyPenalty } : {}),
    ...(s?.presencePenalty !== undefined ? { presencePenalty: s.presencePenalty } : {}),
    ...(s?.seed !== undefined ? { seed: s.seed } : {}),
    ...(s?.stopSequences ? { stopSequences: [...s.stopSequences] } : {}),
    ...(s?.maxOutputTokens ? { maxOutputTokens: s.maxOutputTokens } : {}),
    // Cast: the passthrough is intentionally loose (provider-specific JSON).
    ...(s?.providerOptions ? { providerOptions: s.providerOptions as never } : {}),
  };
}

function isCustomModel(model: ModelLike): model is CustomModel {
  return typeof model === 'function';
}

interface ProviderErrorish {
  statusCode?: number;
  status?: number;
  responseHeaders?: Record<string, string>;
  message?: string;
  name?: string;
  code?: string;
  cause?: unknown;
  // Providers and the AI SDK often nest the real reason (e.g. insufficient_quota) in the error body.
  data?: unknown;
  responseBody?: string;
}

// Unambiguous account-state signals: codes and wordings that only ever describe an exhausted balance.
const BILLING_ALWAYS_RE =
  /insufficient_quota|credit balance is too low|prepayment credits?|out of credits|credits?\s+(?:are\s+|is\s+)?(?:depleted|exhausted)/iu;
// Quota wordings vendors also use for transient window caps; billing only without a retry hint.
const BILLING_QUOTA_RE = /exceeded your current quota|quota exceeded/iu;
const RETRY_HINT_RE = /retrydelay|retryinfo|try again in/iu;

/** True when a provider error means the ACCOUNT is out of credits, as opposed to a transient rate limit. */
function isBillingExhaustion(e: ProviderErrorish, msg: string, status: number | undefined): boolean {
  // Vendors signal quota/billing on 400 (Anthropic), 402, 403 or 429, never on 5xx or transport errors.
  if (status !== undefined && status !== 400 && status !== 402 && status !== 403 && status !== 429) return false;
  let dataStr = '';
  try {
    dataStr = e.data !== undefined ? (JSON.stringify(e.data) ?? '') : '';
  } catch {
    // Circular data cannot carry a JSON body signal; responseBody is still checked.
  }
  const hay = `${msg} ${e.code ?? ''} ${dataStr.slice(0, 2048)} ${(e.responseBody ?? '').slice(0, 2048)}`;
  if (BILLING_ALWAYS_RE.test(hay)) return true;
  if (!BILLING_QUOTA_RE.test(hay)) return false;
  // A granted limit of zero means no allocation at all - waiting never helps.
  if (/limit:\s*0\b/iu.test(hay)) return true;
  // Quota wording plus a retry hint is a per-minute cap, not billing.
  return !(RETRY_HINT_RE.test(hay) || retryAfterMs(e) !== null);
}

const UNSUPPORTED_TEMPERATURE_RE =
  /(?:unsupported|not support(?:ed)?|does not support)[^.]{0,60}temperature|temperature[^.]{0,60}(?:unsupported|not support(?:ed)?)/iu;

/** True when a provider rejected the request because the model does not accept `temperature`. */
export function isUnsupportedTemperatureError(err: unknown): boolean {
  const e = (err ?? {}) as ProviderErrorish;
  const status = typeof e.statusCode === 'number' ? e.statusCode : typeof e.status === 'number' ? e.status : undefined;
  if (status !== undefined && status !== 400) return false;
  const text = `${String(e.message ?? '')} ${(e.responseBody ?? '').slice(0, 1024)}`;
  return UNSUPPORTED_TEMPERATURE_RE.test(text);
}

/** Map any provider/transport failure to the taxonomy. Exported for tests. */
export function classifyLlmError(err: unknown, callerAborted: boolean): AskSqlError {
  if (AskSqlError.is(err)) return err;
  const e = (err ?? {}) as ProviderErrorish;
  const msg = String(e.message ?? err ?? '');
  const name = String(e.name ?? '');

  if (callerAborted || name === 'AbortError' || /aborted/iu.test(msg)) {
    return new AskSqlError(callerAborted ? 'CANCELLED' : 'LLM_TIMEOUT', {
      detail: `aborted: ${msg.slice(0, 200)}`,
      cause: err,
    });
  }

  const status = typeof e.statusCode === 'number' ? e.statusCode : typeof e.status === 'number' ? e.status : undefined;
  if (isBillingExhaustion(e, msg, status)) {
    return new AskSqlError('LLM_BILLING', { detail: `quota/billing: ${msg.slice(0, 200)}`, cause: err });
  }
  if (status === 401) {
    return new AskSqlError('LLM_AUTH', { detail: 'provider returned 401', cause: err });
  }
  // 403: a rejected key, or a local server refusing the caller's origin.
  if (status === 403) {
    return new AskSqlError('LLM_AUTH', {
      detail: 'provider returned 403',
      userMessage:
        'The AI provider refused the request (403). If you configured an API key, check it. If this is a local model, the server may be refusing requests from this app - see its allowed-origins setting.',
      cause: err,
    });
  }
  if (status === 429) {
    return new AskSqlError('LLM_RATE_LIMIT', { detail: `provider returned 429`, cause: err });
  }
  // A wrong or unpulled model id is the most common first-setup mistake.
  if (
    status === 404 ||
    /\bmodel\b[^.]*(?:not found|does ?n[o']?t exist|unknown|unavailable)|no such model|try pulling/iu.test(msg)
  ) {
    return new AskSqlError('CONFIG_ERROR', {
      detail: `model not found: ${msg.slice(0, 300)}`,
      userMessage:
        'That AI model was not found at this provider. Check the model name in your AskSQL configuration - the id must match exactly (for a local model, pull it first).',
      cause: err,
    });
  }
  if ((status === 400 || status === 413) && /context|token|length|maximum|too long|exceeds/iu.test(msg)) {
    return new AskSqlError('LLM_CONTEXT_OVERFLOW', { detail: msg.slice(0, 300), cause: err });
  }
  if (status !== undefined && status >= 500) {
    return new AskSqlError('LLM_UNAVAILABLE', { detail: `provider returned ${status}`, cause: err, retryable: true });
  }
  if (status !== undefined) {
    return new AskSqlError('LLM_UNAVAILABLE', {
      detail: `provider returned ${status}: ${msg.slice(0, 300)}`,
      cause: err,
      retryable: false,
    });
  }
  const transport = String(e.code ?? '') + ' ' + msg;
  if (/econnrefused|enotfound|econnreset|etimedout|fetch failed|network|socket|dns/iu.test(transport)) {
    return new AskSqlError('LLM_UNREACHABLE', { detail: transport.trim().slice(0, 300), cause: err });
  }
  return new AskSqlError('LLM_UNAVAILABLE', { detail: msg.slice(0, 300), cause: err, retryable: false });
}

function retryAfterMs(err: unknown): number | null {
  const headers = (err as ProviderErrorish | null)?.responseHeaders;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return Math.min(Math.max(asDate - Date.now(), 0), 30_000);
  return null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AskSqlError('CANCELLED'));
      },
      { once: true },
    );
  });

async function callOnce(input: LlmCallInput, signal: AbortSignal, omitTemperature: boolean): Promise<LlmCallResult> {
  if (isCustomModel(input.model)) {
    const out = await input.model({ system: input.system, prompt: input.prompt, signal });
    if (typeof out === 'string') {
      if (input.onToken) input.onToken(out);
      return { text: out, usage: {} };
    }
    let acc = '';
    for await (const chunk of out) {
      if (signal.aborted) throw new AskSqlError('CANCELLED');
      acc += chunk;
      input.onToken?.(chunk);
    }
    return { text: acc, usage: {} };
  }

  // The AI SDK routes stream-phase failures onto the stream as error parts, not into the consuming loop.
  const modelId = typeof input.model === 'string' ? input.model : (input.model as { modelId?: string }).modelId;
  const result = streamText({
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    abortSignal: signal,
    ...buildLlmRequestOptions(input.settings, modelId, omitTemperature),
    // The engine owns retry policy; disable the SDK's internal retries.
    maxRetries: 0,
  });

  let acc = '';
  for await (const part of result.fullStream) {
    if (part.type === 'error') {
      throw part.error ?? new AskSqlError('LLM_UNAVAILABLE', { detail: 'provider stream error (no detail)' });
    }
    if (part.type === 'text-delta') {
      acc += part.text;
      input.onToken?.(part.text);
    }
  }
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  try {
    usage = await result.usage;
  } catch {
    usage = undefined;
  }
  return {
    text: acc,
    usage: {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    },
  };
}

/** Call the model with an overall timeout and bounded, jittered retries; auth failures never retry. */
export async function callModel(input: LlmCallInput): Promise<LlmCallResult> {
  const timeoutMs = input.settings?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = input.settings?.maxRetries ?? DEFAULT_MAX_RETRIES;

  let attempt = 0;
  let omitTemperature = false;
  // Attempts = 1 initial + maxRetries retries.
  for (;;) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`AskSQL LLM timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const onCallerAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (input.signal?.aborted) controller.abort(input.signal.reason);

    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let abortReject: (() => void) | null = null;
    try {
      // Hard timeout + caller-abort race: a model that ignores cancellation still cannot hang the caller.
      const result = await Promise.race([
        callOnce(input, controller.signal, omitTemperature),
        new Promise<never>((_, reject) => {
          hardTimer = setTimeout(() => {
            timedOut = true;
            reject(
              new AskSqlError('LLM_TIMEOUT', {
                detail: `hard timeout after ${timeoutMs}ms (model ignored cancellation)`,
              }),
            );
          }, timeoutMs);
          // Node only; a browser timer id has no unref.
          (hardTimer as { unref?: () => void }).unref?.();
        }),
        new Promise<never>((_, reject) => {
          if (!input.signal) return;
          abortReject = () => reject(new AskSqlError('CANCELLED'));
          if (input.signal.aborted) abortReject();
          else input.signal.addEventListener('abort', abortReject, { once: true });
        }),
      ]);
      return result;
    } catch (err) {
      if (timedOut && !(input.signal?.aborted ?? false)) {
        throw AskSqlError.is(err) && err.code === 'LLM_TIMEOUT' ? err : new AskSqlError('LLM_TIMEOUT');
      }
      const callerAborted = input.signal?.aborted ?? false;
      // A provider that rejects `temperature` gets one re-send without it, outside the retry budget.
      if (!callerAborted && !omitTemperature && isUnsupportedTemperatureError(err)) {
        omitTemperature = true;
        continue;
      }
      const mapped = classifyLlmError(err, callerAborted);
      const canRetry = mapped.retryable && mapped.code !== 'LLM_TIMEOUT' && attempt < maxRetries && !callerAborted;
      if (!canRetry) throw mapped;
      const hinted = retryAfterMs(err);
      const backoff = hinted ?? Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 15_000);
      attempt += 1;
      await sleep(backoff, input.signal);
    } finally {
      clearTimeout(timer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      input.signal?.removeEventListener('abort', onCallerAbort);
      if (abortReject) input.signal?.removeEventListener('abort', abortReject);
    }
  }
}
