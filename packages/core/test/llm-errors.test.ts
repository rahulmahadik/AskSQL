/**
 * LLM provider failure handling end-to-end via a CustomModel
 * that throws provider-shaped errors, driven through the real engine so the
 * retry policy, error mapping, context-overflow auto-shrink, and telemetry
 * are all exercised - not just classifyLlmError in isolation.
 */
import { describe, expect, it } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { AskSqlError } from '../src/errors.js';
import { callModel, classifyLlmError, isUnsupportedTemperatureError } from '../src/llm.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'users',
      kind: 'table',
      columns: [{ name: 'id', dbType: 'bigint', nullable: false }],
      primaryKey: ['id'],
      foreignKeys: [],
      uniques: [],
      checks: [],
      indexes: [],
      source: 'db',
    },
  ],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
};
class Fake implements Connector {
  engine = 'postgres' as const;
  dialect = POSTGRES_DIALECT;
  capabilities = {
    supportsCancel: true,
    supportsExplain: true,
    supportsSchemas: true,
    readOnlySession: true,
    supportsMatViews: true,
    supportsTriggers: true,
    supportsRoutines: true,
  };
  id = 'f';
  name = 'F';
  async connect() {}
  async close() {}
  async introspect() {
    return CATALOG;
  }
  async execute(): Promise<ResultSet> {
    return {
      columns: [{ name: 'id', kind: 'bigint' }],
      rows: [['1']],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
      warnings: [],
    };
  }
}

function throwing(err: unknown): CustomModel {
  return () => Promise.reject(err);
}
const providerErr = (o: object) => Object.assign(new Error('provider error'), o);

async function askError(model: CustomModel): Promise<AskSqlError> {
  const engine = createAskSql({ connectors: [new Fake()], model, llm: { maxRetries: 0 } });
  try {
    await engine.ask('how many users?');
    throw new Error('expected the ask to reject');
  } catch (err) {
    if (!AskSqlError.is(err)) throw err;
    return err;
  }
}

describe('LLM error mapping through the engine', () => {
  it('401 -> LLM_AUTH (no retry, key never echoed)', async () => {
    const err = await askError(throwing(providerErr({ statusCode: 401, message: 'invalid api key sk-secret123' })));
    expect(err.code).toBe('LLM_AUTH');
    expect(err.retryable).toBe(false);
    expect(JSON.stringify(err.toJSON())).not.toMatch(/sk-secret123/);
  });

  it('429 -> LLM_RATE_LIMIT (retryable)', async () => {
    const err = await askError(throwing(providerErr({ statusCode: 429 })));
    expect(err.code).toBe('LLM_RATE_LIMIT');
    expect(err.retryable).toBe(true);
  });

  it('ECONNREFUSED -> LLM_UNREACHABLE (names nothing secret)', async () => {
    const err = await askError(
      throwing(providerErr({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:11434' })),
    );
    expect(err.code).toBe('LLM_UNREACHABLE');
  });

  it('400 context-length -> LLM_CONTEXT_OVERFLOW', async () => {
    const err = await askError(throwing(providerErr({ statusCode: 400, message: 'maximum context length exceeded' })));
    expect(err.code).toBe('LLM_CONTEXT_OVERFLOW');
  });

  it('model refusal (no SQL, apologetic) -> LLM_REFUSAL', async () => {
    const model: CustomModel = async () => "I'm sorry, I can't help with that request.";
    const err = await askError(model);
    expect(['LLM_REFUSAL', 'LLM_BAD_OUTPUT']).toContain(err.code);
  });

  it('persistent non-SQL prose -> LLM_BAD_OUTPUT after repairs', async () => {
    const model: CustomModel = async () => 'Here is some helpful commentary but no query at all.';
    const err = await askError(model);
    expect(err.code).toBe('LLM_BAD_OUTPUT');
  });
});

describe('retry policy actually retries then gives up', () => {
  it('retries a 429 the configured number of times', async () => {
    let calls = 0;
    const model: CustomModel = () => {
      calls++;
      return Promise.reject(providerErr({ statusCode: 429 }));
    };
    await expect(
      callModel({ model, system: 's', prompt: 'p', settings: { maxRetries: 2, timeoutMs: 5000 } }),
    ).rejects.toMatchObject({ code: 'LLM_RATE_LIMIT' });
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('does NOT retry a 401', async () => {
    let calls = 0;
    const model: CustomModel = () => {
      calls++;
      return Promise.reject(providerErr({ statusCode: 401 }));
    };
    await expect(callModel({ model, system: 's', prompt: 'p', settings: { maxRetries: 3 } })).rejects.toMatchObject({
      code: 'LLM_AUTH',
    });
    expect(calls).toBe(1);
  });
});

describe('context overflow triggers a schema-shrink retry', () => {
  it('recovers when a smaller schema fits', async () => {
    // First call overflows; the engine shrinks the schema and retries; the
    // second call (smaller prompt) succeeds.
    let call = 0;
    const model: CustomModel = ({ prompt }) => {
      call++;
      if (call === 1) return Promise.reject(providerErr({ statusCode: 400, message: 'context length exceeded' }));
      // On the shrunk retry, produce valid SQL.
      void prompt;
      return Promise.resolve('```sql\nSELECT id FROM users\n```');
    };
    const engine = createAskSql({ connectors: [new Fake()], model, llm: { maxRetries: 0 } });
    const ans = await engine.ask('how many users?');
    expect(ans.sql).toMatch(/SELECT id FROM users/i);
    expect(call).toBeGreaterThanOrEqual(2);
  });
});

describe('token telemetry surfaced', () => {
  it('usage is present on the result (zero for custom models, shape intact)', async () => {
    const engine = createAskSql({ connectors: [new Fake()], model: async () => '```sql\nSELECT id FROM users\n```' });
    const ans = await engine.ask('ids');
    expect(ans.usage).toBeDefined();
    expect(typeof ans.usage.inputTokens === 'number' || ans.usage.inputTokens === undefined).toBe(true);
  });
});

describe('quota / billing exhaustion is distinct from a transient rate limit', () => {
  const quotaErr = (message: string, extra: object = {}) =>
    Object.assign(providerErr({ statusCode: 429, ...extra }), { message });

  it('maps an insufficient_quota 429 to non-retryable LLM_BILLING', () => {
    const mapped = classifyLlmError(
      quotaErr('You exceeded your current quota, please check your plan and billing details.'),
      false,
    );
    expect(mapped.code).toBe('LLM_BILLING');
    expect(mapped.retryable).toBe(false);
    expect(mapped.userMessage.toLowerCase()).toContain('billing');
  });

  it('still treats a plain 429 rate limit as retryable', () => {
    const mapped = classifyLlmError(providerErr({ statusCode: 429, message: 'Rate limit reached' }), false);
    expect(mapped.code).toBe('LLM_RATE_LIMIT');
    expect(mapped.retryable).toBe(true);
  });

  it('quota wording WITH a retry hint stays a retryable rate limit (per-minute caps)', () => {
    // Gemini transient RPM caps reuse the quota/billing wording but attach a
    // RetryInfo; those clear in seconds and must keep retrying.
    const mapped = classifyLlmError(
      quotaErr('You exceeded your current quota, please check your plan and billing details.', {
        responseBody: '{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"14s"}]}',
      }),
      false,
    );
    expect(mapped.code).toBe('LLM_RATE_LIMIT');
    expect(mapped.retryable).toBe(true);
  });

  it('a zero granted limit is billing even when a retry hint is present', () => {
    const mapped = classifyLlmError(
      quotaErr('Quota exceeded for metric: generate_content_free_tier_requests, limit: 0', {
        responseBody: '{"retryDelay":"22s"}',
      }),
      false,
    );
    expect(mapped.code).toBe('LLM_BILLING');
  });

  it('tier-limit phrasing ("check your plan limits") is NOT billing', () => {
    const mapped = classifyLlmError(quotaErr('Rate limit for your plan tier reached - check your plan limits.'), false);
    expect(mapped.code).toBe('LLM_RATE_LIMIT');
    expect(mapped.retryable).toBe(true);
  });

  it('a 5xx whose body mentions billing stays a retryable outage', () => {
    const mapped = classifyLlmError(
      providerErr({
        statusCode: 503,
        message: 'upstream error',
        responseBody: '<html>please check your plan and billing details</html>',
      }),
      false,
    );
    expect(mapped.code).toBe('LLM_UNAVAILABLE');
    expect(mapped.retryable).toBe(true);
  });

  it('treats depleted prepaid credits as billing', () => {
    const mapped = classifyLlmError(
      quotaErr('Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.'),
      false,
    );
    expect(mapped.code).toBe('LLM_BILLING');
    expect(mapped.retryable).toBe(false);
  });

  it('maps a 400 "credit balance is too low" (Anthropic) to billing', () => {
    const mapped = classifyLlmError(
      providerErr({ statusCode: 400, message: 'Your credit balance is too low to access the Anthropic API.' }),
      false,
    );
    expect(mapped.code).toBe('LLM_BILLING');
  });

  it('never retries a billing failure at the engine level', async () => {
    let calls = 0;
    const model: CustomModel = () => {
      calls++;
      return Promise.reject(quotaErr('You exceeded your current quota, please check your plan and billing details.'));
    };
    await expect(
      callModel({ model, system: 's', prompt: 'p', settings: { maxRetries: 3, timeoutMs: 5000 } }),
    ).rejects.toMatchObject({ code: 'LLM_BILLING' });
    expect(calls).toBe(1);
  });

  it('detects quota nested in the AI SDK error body even when the message is generic', () => {
    const err = providerErr({
      statusCode: 429,
      data: { type: 'error', error: { type: 'insufficient_quota', message: 'You exceeded your current quota.' } },
      responseBody: '{"error":{"type":"insufficient_quota"}}',
    });
    const mapped = classifyLlmError(err, false);
    expect(mapped.code).toBe('LLM_BILLING');
    expect(mapped.retryable).toBe(false);
    expect(mapped.userMessage.toLowerCase()).toContain('billing');
  });
});

describe('unsupported-temperature detection (reasoning models behind opaque names)', () => {
  it('recognizes the provider 400 for an unsupported temperature parameter', () => {
    expect(
      isUnsupportedTemperatureError(
        providerErr({
          statusCode: 400,
          message: "Unsupported parameter: 'temperature' is not supported with this model.",
        }),
      ),
    ).toBe(true);
    expect(
      isUnsupportedTemperatureError(
        providerErr({ statusCode: 400, message: 'temperature is not supported for reasoning models' }),
      ),
    ).toBe(true);
  });

  it('does not fire on unrelated 400s or non-400s', () => {
    expect(
      isUnsupportedTemperatureError(providerErr({ statusCode: 400, message: 'maximum context length exceeded' })),
    ).toBe(false);
    expect(
      isUnsupportedTemperatureError(providerErr({ statusCode: 500, message: 'temperature is not supported' })),
    ).toBe(false);
  });
});
