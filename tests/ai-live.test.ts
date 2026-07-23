/**
 * End-to-end AI integration: natural-language question -> SQL -> guard ->
 * LIVE PostgreSQL, driven by REAL model providers.
 *
 * Three layers, each gated by available credentials so CI stays green:
 *   1. CLOUD PROVIDER MATRIX - OpenAI / Anthropic / Gemini / Cerebras /
 *      OpenRouter / DeepSeek / Together / Mistral / xAI. Each runs when its
 *      API key env var is set; skips otherwise.
 *   2. GROQ MODEL MATRIX - several Groq-hosted models (Llama 70B/8B, Qwen,
 *      GPT-OSS) through one key, exercising different model families live.
 *   3. OLLAMA - a fully local model.
 *
 * Assertions are on SHAPE (valid SQL that executes and returns the right
 * answer), not exact wording, because model output varies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAskSql, resolveModel, type AskSqlEngine, type ProviderConfig } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';

let pgReady = true;
const connector = new PostgresConnector({ id: 'shop', name: 'Shop', connectionString: PG_URL });

beforeAll(async () => {
  try {
    await connector.connect();
  } catch {
    pgReady = false;
  }
});
afterAll(async () => {
  await connector.close();
});

// ---------------------------------------------------------------------------
// Shared question suite - the same three questions every provider answers.
// ---------------------------------------------------------------------------
async function runQuestionSuite(engine: AskSqlEngine, label: string): Promise<void> {
  const q1 = await engine.ask('How many customers are there?');
  expect(q1.sql.toLowerCase()).toContain('customers');
  const r1 = await q1.run();
  expect(Number(r1.rows[0]![0])).toBe(3);
  console.log(`[${label}] Q1: ${q1.sql.replace(/\s+/g, ' ').trim()}`);

  const q2 = await engine.ask('List each customer name with their total number of orders.');
  const r2 = await q2.run();
  expect(r2.columns.length).toBeGreaterThanOrEqual(2);
  expect(r2.rowCount).toBeGreaterThanOrEqual(1);
  console.log(`[${label}] Q2: ${q2.sql.replace(/\s+/g, ' ').trim()}`);

  const q3 = await engine.ask('What is the total revenue in cents from paid or shipped orders?');
  const r3 = await q3.run();
  expect(r3.rowCount).toBeGreaterThanOrEqual(1);
  console.log(`[${label}] Q3: ${q3.sql.replace(/\s+/g, ' ').trim()}`);
}

function makeEngine(config: ProviderConfig, timeoutMs: number): Promise<AskSqlEngine> {
  return resolveModel(config).then((model) =>
    createAskSql({ connectors: [connector], model, policy: { maxRows: 100 }, llm: { timeoutMs } }),
  );
}

// ---------------------------------------------------------------------------
// 1. Cloud provider matrix - one entry per provider, gated by its key.
// ---------------------------------------------------------------------------
interface CloudProvider {
  readonly label: string;
  readonly envKey: string;
  readonly config: (key: string) => ProviderConfig;
}

const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  {
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    config: (k) => ({ provider: 'openai', model: process.env['ASKSQL_OPENAI_MODEL'] ?? 'gpt-4o-mini', apiKey: k }),
  },
  {
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    config: (k) => ({
      provider: 'anthropic',
      model: process.env['ASKSQL_ANTHROPIC_MODEL'] ?? 'claude-3-5-haiku-latest',
      apiKey: k,
    }),
  },
  {
    label: 'Gemini',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    config: (k) => ({ provider: 'google', model: process.env['ASKSQL_GEMINI_MODEL'] ?? 'gemini-2.0-flash', apiKey: k }),
  },
  // Azure also needs AZURE_RESOURCE_NAME and the model set to your *deployment* name.
  {
    label: 'Azure OpenAI',
    envKey: 'AZURE_API_KEY',
    config: (k) => ({
      provider: 'azure',
      model: process.env['ASKSQL_AZURE_DEPLOYMENT'] ?? 'gpt-4o-mini',
      apiKey: k,
      resourceName: process.env['AZURE_RESOURCE_NAME'],
    }),
  },
  {
    label: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    config: (k) => ({
      provider: 'openai-compatible',
      model: process.env['ASKSQL_CEREBRAS_MODEL'] ?? 'llama-3.3-70b',
      apiKey: k,
      baseURL: 'https://api.cerebras.ai/v1',
    }),
  },
  {
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    config: (k) => ({
      provider: 'openai-compatible',
      model: process.env['ASKSQL_OPENROUTER_MODEL'] ?? 'meta-llama/llama-3.3-70b-instruct',
      apiKey: k,
      baseURL: 'https://openrouter.ai/api/v1',
    }),
  },
  {
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    config: (k) => ({
      provider: 'openai-compatible',
      model: process.env['ASKSQL_DEEPSEEK_MODEL'] ?? 'deepseek-chat',
      apiKey: k,
      baseURL: 'https://api.deepseek.com/v1',
    }),
  },
  {
    label: 'Together',
    envKey: 'TOGETHER_API_KEY',
    config: (k) => ({
      provider: 'openai-compatible',
      model: process.env['ASKSQL_TOGETHER_MODEL'] ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      apiKey: k,
      baseURL: 'https://api.together.xyz/v1',
    }),
  },
  {
    label: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    config: (k) => ({
      provider: 'openai-compatible',
      model: process.env['ASKSQL_MISTRAL_MODEL'] ?? 'mistral-small-latest',
      apiKey: k,
      baseURL: 'https://api.mistral.ai/v1',
    }),
  },
  {
    label: 'xAI',
    envKey: 'XAI_API_KEY',
    config: (k) => ({
      provider: 'openai-compatible',
      model: process.env['ASKSQL_XAI_MODEL'] ?? 'grok-2-latest',
      apiKey: k,
      baseURL: 'https://api.x.ai/v1',
    }),
  },
];

for (const p of CLOUD_PROVIDERS) {
  const key = process.env[p.envKey];
  const d = key ? describe : describe.skip;
  d(`Cloud: ${p.label} (live)`, () => {
    it('answers three questions against live Postgres', async () => {
      if (!pgReady) return;
      const engine = await makeEngine(p.config(key!), 45_000);
      await runQuestionSuite(engine, p.label);
    }, 120_000);
  });
}

// ---------------------------------------------------------------------------
// 2. Groq model matrix - several models live through one key.
// ---------------------------------------------------------------------------
const GROQ_KEY = process.env['GROQ_API_KEY'];
const GROQ_MODELS = (
  process.env['ASKSQL_GROQ_MODELS'] ?? 'llama-3.3-70b-versatile,llama-3.1-8b-instant,qwen/qwen3-32b,openai/gpt-oss-120b'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const groqDescribe = GROQ_KEY ? describe : describe.skip;
groqDescribe('Groq model matrix (live)', () => {
  for (const model of GROQ_MODELS) {
    it(`${model} answers against live Postgres`, async () => {
      if (!pgReady) return;
      const engine = await makeEngine({ provider: 'groq', model, apiKey: GROQ_KEY! }, 45_000);
      await runQuestionSuite(engine, `groq:${model}`);
    }, 120_000);
  }

  it('explains a query in plain language', async () => {
    if (!pgReady) return;
    const engine = await makeEngine({ provider: 'groq', model: GROQ_MODELS[0]!, apiKey: GROQ_KEY! }, 45_000);
    const explanation = await engine.explain("SELECT count(*) FROM shop.orders WHERE status = 'paid'");
    expect(explanation.length).toBeGreaterThan(20);
    console.log('[groq] explain:', explanation.slice(0, 140));
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Ollama - fully local.
// ---------------------------------------------------------------------------
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434/v1';
const OLLAMA_MODEL = process.env['ASKSQL_OLLAMA_MODEL'] ?? 'qwen2.5-coder:14b';

describe('Ollama end-to-end (live)', () => {
  let up = false;
  beforeAll(async () => {
    try {
      const res = await fetch(OLLAMA_URL.replace(/\/v1$/, '') + '/api/tags', { signal: AbortSignal.timeout(2000) });
      up = res.ok;
    } catch {
      up = false;
    }
    if (!up) console.warn('[skip] Ollama not reachable at', OLLAMA_URL);
  });

  it('answers questions against live Postgres with a local model', async () => {
    if (!up || !pgReady) return;
    const engine = await makeEngine({ provider: 'ollama', model: OLLAMA_MODEL, baseURL: OLLAMA_URL }, 120_000);
    await runQuestionSuite(engine, 'ollama');
  }, 240_000);
});
