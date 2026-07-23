/**
 * LLM call plumbing: streaming, overall timeout, bounded jittered retries
 * honoring retry-after, AbortSignal propagation, and mapping of provider
 * failures onto the AskSQL error taxonomy.
 *
 * Rule: every call has an explicit timeout - never a transport default -
 * and timeout errors say so in plain words.
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

// Reasoning models (OpenAI o-series, GPT-5 family) reject an explicit
// `temperature` - it is fixed internally. Matches o1/o3/o4.../gpt-5... with or
// without a provider/gateway prefix; "-chat" variants (gpt-5-chat-latest) are
// standard samplers and keep temperature. Name sniffing cannot see through an
// arbitrary Azure deployment name, so callModel also strips temperature
// reactively when a provider rejects it (one retry, no name list needed).
const REASONING_MODEL_RE = /(?:^|[/:])(o[1-9](?:$|[-.\d])|gpt-5)/i;

function isReasoningModelId(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return REASONING_MODEL_RE.test(modelId) && !/chat/i.test(modelId);
}

/**
 * Map the caller's {@link LlmSettings} onto the sampling options a Vercel AI SDK
 * `streamText` call understands. Optional fields are omitted entirely (not sent
 * as `undefined`) so a provider's own default applies when the user didn't set
 * one; `temperature` defaults to 0 (deterministic - the safest default for SQL)
 * but is dropped for reasoning models, which do not support it.
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
  // Providers/AI-SDK frequently nest the real reason (e.g. insufficient_quota)
  // in the parsed error body rather than the top-level message.
  data?: unknown;
  responseBody?: string;
}

// Unambiguous account-state signals: structured error codes plus wordings that
// only ever describe an exhausted balance, never a transient per-minute cap.
const BILLING_ALWAYS_RE =
  /insufficient_quota|credit balance is too low|prepayment credits?|out of credits|credits?\s+(?:are\s+|is\s+)?(?:depleted|exhausted)/iu;
// Quota wordings vendors ALSO use for transient window caps; only billing when
// no retry hint accompanies them (or the granted limit is literally zero).
const BILLING_QUOTA_RE = /exceeded your current quota|quota exceeded/iu;
const RETRY_HINT_RE = /retrydelay|retryinfo|try again in/iu;

/**
 * True when a provider error means the ACCOUNT is out of credits / over its
 * hard quota - a state retrying can never fix - as opposed to a transient
 * rate limit. Structured signals win; prose is a capped, status-gated
 * fallback so a proxy error page mentioning "billing" can't hijack a 5xx.
 */
function isBillingExhaustion(e: ProviderErrorish, msg: string, status: number | undefined): boolean {
  // Vendors signal quota/billing on 400 (Anthropic), 402, 403, or 429 -
  // never on 5xx or transport errors, whatever their bodies echo.
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

/**
 * True when a provider rejected the request specifically because the model
 * does not accept a `temperature` parameter (reasoning models). Exported for
 * tests; callModel uses it to re-send once without the parameter.
 */
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
  if (status === 401 || status === 403) {
    return new AskSqlError('LLM_AUTH', { detail: `provider returned ${status}`, cause: err });
  }
  if (status === 429) {
    return new AskSqlError('LLM_RATE_LIMIT', { detail: `provider returned 429`, cause: err });
  }
  // A wrong/unpulled model id is the most common first-setup mistake. Without this it
  // fell through to the generic status arm and read as a transient "try again" outage.
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

  // The AI SDK does not throw stream-phase failures into the consuming loop; it
  // routes them onto the stream as error parts and ends it. Consuming the
  // full stream and throwing on the error part surfaces the real failure
  // (quota, mid-stream 5xx, dropped socket) instead of letting it masquerade
  // as a truncated-but-successful completion - and stops token emission at
  // the exact point the provider failed.
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

/**
 * Call the model with an overall timeout and bounded, jittered retries for
 * transient faults (429 / 5xx / network). Auth failures never retry.
 */
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
      // Hard timeout + caller-abort race: a provider or CustomModel that
      // ignores cancellation still can't hang the caller - neither on timeout
      // nor when the caller aborts. (The signal is aborted too, best-effort.)
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
          // Node only; a browser timer id has no unref. Never keep the
          // process alive just for the safety-net timer.
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
      // A provider that rejects `temperature` (reasoning models behind names
      // the id-sniff can't see, e.g. Azure deployments) gets one re-send
      // without it. Does not consume a retry attempt; the flag makes it
      // impossible to loop.
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
