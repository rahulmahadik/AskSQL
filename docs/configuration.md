# Configuration

Prompts, model sampling, the guard's limits, and grounding are all host-configurable on
`createAskSql` - no forking required.

## Model providers

OpenAI, Anthropic, Gemini, Azure (classic + AI Foundry), Groq, NVIDIA, Ollama, or any
OpenAI-compatible endpoint. See **[providers.md](providers.md)** for per-provider config
(including the Azure classic-vs-Foundry gotcha).

## Prompts

`config.prompts` extends or fully replaces the system prompt:

```ts
const engine = createAskSql({
  connectors: [connector],
  model,
  prompts: {
    // Append house rules to the built-in prompt:
    instructions: 'Prefer CTEs over subqueries. Alias every aggregate.',
    // ...or replace it entirely (you own correctness guidance - the AST guard
    // still enforces read-only regardless of what the prompt says):
    // system: ({ dialectLabel, maxRows }) => `You are a ${dialectLabel} analyst...`,
  },
});
```

## Model sampling

`config.llm` - every knob is optional; unset ones fall back to the provider default, and
`temperature` defaults to `0` (deterministic, best for SQL):

```ts
const engine = createAskSql({
  connectors: [connector],
  model,
  llm: {
    temperature: 0,          // 0 = deterministic (default)
    topP: 0.9,               // nucleus sampling (prefer temperature OR topP)
    topK: 40,                // where the provider supports it
    frequencyPenalty: 0.2,
    presencePenalty: 0,
    seed: 42,                // reproducible sampling where supported
    stopSequences: ['\n\n'],
    maxRetries: 2,           // retries on 429 / 5xx / network (default 2)
    timeoutMs: 60000,        // per-call timeout (default 60s)
    maxOutputTokens: 1024,   // cap the completion length
    // Escape hatch for provider-specific knobs (reasoning effort, etc.):
    providerOptions: { groq: { reasoning_format: 'hidden' } },
  },
});
```

## Guard policy

`config.policy` - the read-only floor is immovable, but the limits around it are yours to set:

```ts
const engine = createAskSql({
  connectors: [connector],
  model,
  policy: {
    maxRows: 1000,               // LIMIT injected when missing / lowered when higher.
                                 // Default 1000, clamped to at most 100000.
    denyFunctions: ['pg_sleep'], // extra names blocked on top of the built-in denylist
    allowFileFunctions: false,   // read_csv/read_parquet - true only for browser DuckDB.
                                 // Credential and settings functions stay denied either way.
    maxSqlLength: 100000,        // reject pathologically long SQL
    maxDepth: 400,               // AST walk depth cap (fails closed)
  },
});
```

## Grounding

Two optional inputs make generation sharper without touching the guard:

```ts
const engine = createAskSql({
  connectors: [connector],
  model,
  // Define house vocabulary so "MRR" or "active user" map to real columns:
  glossary: [{ term: 'active user', definition: 'a user with an event in the last 30 days' }],
  // Approved question -> SQL pairs are retrieved as few-shots on later asks:
  fewShots: new MemoryFewShotStore(),
});
// After a user approves an answer, teach the engine (only stored if it passes the guard):
await engine.recordFeedback('top customers by revenue', approvedSql, { connectionId: 'shop' });
```
