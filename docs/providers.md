# Configuring a model provider

AskSQL is bring-your-own-LLM. You build a model with `resolveModel(config)` and
pass it to `createAskSql({ connectors, model })`. The provider only ever sees
your **schema** and the question - never your data - and writes SQL that the
guard checks before it runs against your database.

The `config` shape (all providers):

```ts
interface ProviderConfig {
  provider: 'openai' | 'anthropic' | 'google' | 'azure' | 'groq' | 'ollama' | 'openai-compatible';
  model: string;          // model id, or (Azure) your deployment name
  apiKey?: string;
  baseURL?: string;       // for ollama / openai-compatible / Azure AI Foundry
  resourceName?: string;  // classic Azure OpenAI only
  headers?: Record<string, string>;
}
```

What each field means:

| Field | Meaning | Required when |
|-------|---------|---------------|
| `provider` | Which SDK adapter to load. Picks the wire protocol and default endpoint. | always |
| `model` | The model id to call (`gpt-4o-mini`, `llama-3.3-70b-versatile`, ...). For **classic Azure**, this is your **deployment name**, not the base model name. | always |
| `apiKey` | Your provider secret, sent as the bearer token. Keep it on the server, never in the browser. | all cloud providers (every one except `ollama`) |
| `baseURL` | Full endpoint URL to override the provider default. Point it at a local runtime (Ollama), any OpenAI-compatible host, or an Azure AI Foundry endpoint. | `openai-compatible`; optional for `ollama` (defaults to `http://localhost:11434/v1`) |
| `resourceName` | Classic Azure OpenAI resource subdomain, from `https://<resourceName>.openai.azure.com`. Used only to build the classic Azure endpoint. | classic `azure` when `baseURL` is not set |
| `headers` | Extra HTTP headers merged into every request (custom auth, routing tags for a gateway). | never; optional |

Install only the SDK for the provider you use (they are optional peer deps):
`pnpm add @ai-sdk/openai` (or `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/groq`,
`@ai-sdk/openai-compatible`).

## Quick reference

| Provider (`provider`) | You need | Get a key |
|-----------------------|----------|-----------|
| `openai` | `apiKey` | platform.openai.com (API keys) |
| `anthropic` | `apiKey` | console.anthropic.com (API keys) |
| `google` (Gemini) | `apiKey` | Google AI Studio (API keys) |
| `groq` | `apiKey` | console.groq.com (keys) |
| `ollama` (local) | nothing (default `baseURL`) | - |
| `openai-compatible` | `baseURL` + usually `apiKey` | your endpoint's dashboard |
| `azure` (classic) | `apiKey` + `resourceName` + deployment name | Azure Portal |

Provider dashboards and their key formats change - the linked page is always the
authoritative source. Only Ollama needs no key.

## Cloud providers

```ts
// OpenAI
resolveModel({ provider: 'openai', model: 'gpt-4o-mini', apiKey });

// Anthropic
resolveModel({ provider: 'anthropic', model: 'claude-3-5-haiku-latest', apiKey });

// Google Gemini
resolveModel({ provider: 'google', model: 'gemini-2.0-flash', apiKey });

// Groq
resolveModel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey });
```

## Local model (Ollama)

No key. `baseURL` defaults to `http://localhost:11434/v1`.

```ts
resolveModel({ provider: 'ollama', model: 'qwen2.5-coder:7b' });
```

## Any OpenAI-compatible endpoint

One provider, `openai-compatible`, covers every service that speaks the OpenAI
API - OpenRouter, Together, DeepSeek, Mistral, xAI, Cerebras, Fireworks,
LM Studio, vLLM, and more. Just point `baseURL` at it:

```ts
resolveModel({
  provider: 'openai-compatible',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey,
  model: 'meta-llama/llama-3.3-70b-instruct',
});
```

## Azure - two different setups

Azure has **two** endpoint styles, and they use **different** providers.

**1. Classic Azure OpenAI** - endpoint looks like `https://<resource>.openai.azure.com`.
Use `provider: 'azure'`, pass `resourceName` (the subdomain) and set `model` to
your **deployment name** (not the base model name). We build the endpoint for you.

```ts
resolveModel({
  provider: 'azure',
  resourceName: 'my-resource',      // from https://my-resource.openai.azure.com
  model: 'my-gpt4o-deployment',     // the deployment name you created
  apiKey,
});
```

**2. Azure AI Foundry** - endpoint looks like
`https://<resource>.services.ai.azure.com/openai/v1`. This surface is
**OpenAI-compatible**, so use `provider: 'openai'` (or `openai-compatible`) with a
`baseURL` - **not** the `azure` provider:

```ts
resolveModel({
  provider: 'openai',
  baseURL: 'https://<resource>.services.ai.azure.com/openai/v1',
  apiKey,                            // your Foundry key works as a bearer token
  model: 'gpt-5-mini',              // your deployment name
});
```

In both cases you must **deploy a model first** in Azure (Portal or AI Foundry ->
Deployments). A brand-new Azure resource has no deployments, and every call fails
with `The API deployment for this resource does not exist` until you create one.
Azure OpenAI is paid; there is no free tier.

## Reasoning models

OpenAI o-series (`o1`/`o3`/`o4...`) and the GPT-5 family fix `temperature`
internally and reject it. AskSQL omits `temperature` automatically for these
model ids, and if a provider still rejects it (for example an Azure deployment
whose name hides the model family), the request is re-sent once without the
parameter. Either way, reasoning models work with no extra configuration.

## Notes

- **Sampling** (`config.llm`: `temperature`, `topP`, `topK`, `seed`, ...) is
  documented in the main README under Configuration. Unset knobs fall back to the
  provider default.
- **Errors are actionable:** a bad key surfaces as `LLM_AUTH`; an account that
  is out of credits or over its hard quota surfaces as `LLM_BILLING` and is not
  retried, while transient rate limits stay `LLM_RATE_LIMIT` and retry with
  backoff.
- Only `code` + `userMessage` + `retryable` are ever returned on the wire - no
  prompt, schema, or raw provider response leaks to the client.
