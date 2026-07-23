/**
 * Configurable prompts + LLM sampling parameters. Two host-facing knobs:
 *   config.prompts - override or extend the system prompt
 *   config.llm     - temperature / topP / topK / seed / stopSequences / ...
 * Verifies the prompt override actually reaches the model, and the sampling
 * settings map onto the provider request (present when set, omitted otherwise).
 */
import { describe, expect, it } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { buildSqlSystem } from '../src/prompt.js';
import { buildLlmRequestOptions } from '../src/llm.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'orders',
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
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async introspect(): Promise<SchemaCatalog> {
    return CATALOG;
  }
  async execute(): Promise<ResultSet> {
    return {
      columns: [{ name: 'n', kind: 'number' }],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
      warnings: [],
    };
  }
}

/** A model that records the system prompt it was handed. */
function systemCapturing(): { model: CustomModel; systems: string[] } {
  const systems: string[] = [];
  const model: CustomModel = async ({ system }) => {
    systems.push(system);
    return '```sql\nSELECT id FROM orders\n```';
  };
  return { model, systems };
}

describe('config.prompts - system prompt override', () => {
  it('default system prompt introduces AskSQL and names the dialect', () => {
    const sys = buildSqlSystem(POSTGRES_DIALECT, 100);
    expect(sys).toContain('AskSQL');
    expect(sys).toContain(POSTGRES_DIALECT.promptLabel);
  });

  it('prompts.system fully replaces the system prompt and receives dialect + row cap', () => {
    const seen: Array<{ dialectLabel: string; maxRows: number }> = [];
    const sys = buildSqlSystem(POSTGRES_DIALECT, 250, {
      system: (ctx) => {
        seen.push(ctx);
        return `CUSTOM SYSTEM for ${ctx.dialectLabel} cap=${ctx.maxRows}`;
      },
    });
    expect(sys).toBe(`CUSTOM SYSTEM for ${POSTGRES_DIALECT.promptLabel} cap=250`);
    expect(seen).toEqual([{ dialectLabel: POSTGRES_DIALECT.promptLabel, maxRows: 250 }]);
    // The override is total - none of the default boilerplate leaks through.
    expect(sys).not.toContain('read-only');
  });

  it('prompts.instructions are appended to (not replacing) the default prompt', () => {
    const sys = buildSqlSystem(POSTGRES_DIALECT, 100, { instructions: 'Prefer snake_case aliases.' });
    expect(sys).toContain('AskSQL'); // default retained
    expect(sys).toContain('Additional instructions:');
    expect(sys).toContain('Prefer snake_case aliases.');
  });

  it('the override reaches the model end-to-end via createAskSql', async () => {
    const { model, systems } = systemCapturing();
    const engine = createAskSql({
      connectors: [new Fake()],
      model,
      prompts: { system: () => 'SENTINEL-OVERRIDE-SYSTEM' },
    });
    await engine.ask('how many orders?');
    expect(systems.at(-1)).toBe('SENTINEL-OVERRIDE-SYSTEM');
  });
});

describe('config.llm - sampling parameters map onto the provider request', () => {
  it('defaults to deterministic temperature and sends nothing else', () => {
    const opts = buildLlmRequestOptions();
    expect(opts).toEqual({ temperature: 0 });
  });

  it('forwards every set sampling knob and omits the unset ones', () => {
    const opts = buildLlmRequestOptions({
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      frequencyPenalty: 0.5,
      presencePenalty: 0.25,
      seed: 42,
      stopSequences: [';'],
    });
    expect(opts).toMatchObject({
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      frequencyPenalty: 0.5,
      presencePenalty: 0.25,
      seed: 42,
      stopSequences: [';'],
    });
    // A knob left undefined must be absent (let the provider default apply),
    // never sent as `undefined`.
    const sparse = buildLlmRequestOptions({ topP: 0.1 });
    expect('topK' in sparse).toBe(false);
    expect('seed' in sparse).toBe(false);
    expect(sparse.topP).toBe(0.1);
  });

  it('temperature: 0 is preserved (not coerced away by the ?? default)', () => {
    expect(buildLlmRequestOptions({ temperature: 0 }).temperature).toBe(0);
  });

  it('omits temperature for reasoning models (o-series / gpt-5) but keeps it otherwise', () => {
    expect('temperature' in buildLlmRequestOptions(undefined, 'gpt-5-mini')).toBe(false);
    expect('temperature' in buildLlmRequestOptions({ temperature: 0.5 }, 'o3-mini')).toBe(false);
    expect('temperature' in buildLlmRequestOptions(undefined, 'openai/gpt-5')).toBe(false);
    expect(buildLlmRequestOptions(undefined, 'gpt-4o-mini').temperature).toBe(0);
    // "-chat" gpt-5 variants are standard samplers and keep temperature.
    expect(buildLlmRequestOptions({ temperature: 0.7 }, 'gpt-5-chat-latest').temperature).toBe(0.7);
    // A model that merely contains an o+digit inside a word is not o-series.
    expect(buildLlmRequestOptions(undefined, 'yolo3-vision').temperature).toBe(0);
  });

  it('the omitTemperature flag drops temperature regardless of model name', () => {
    expect('temperature' in buildLlmRequestOptions({ temperature: 0.3 }, 'my-azure-deployment', true)).toBe(false);
    expect(buildLlmRequestOptions({ temperature: 0.3 }, 'my-azure-deployment', false).temperature).toBe(0.3);
  });

  it('passes provider-specific options through untouched', () => {
    const providerOptions = { groq: { reasoning_format: 'hidden' } };
    expect(buildLlmRequestOptions({ providerOptions }).providerOptions).toEqual(providerOptions);
  });
});
