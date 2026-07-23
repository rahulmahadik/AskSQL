/**
 * GEN model-quality battery against live Postgres. These are inherently
 * model-bound, so assertions are TOLERANT: the deterministic invariant is
 * "valid SQL that the guard passes, executes, and (where unambiguous)
 * returns the right answer" - not exact wording. Runs on Groq if keyed,
 * else local Ollama; skips if neither is available.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAskSql, resolveModel, type AskSqlEngine, type ModelLike } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';
const connector = new PostgresConnector({ id: 'shop', name: 'Shop', connectionString: PG_URL });
let engine: AskSqlEngine | null = null;
let model: ModelLike | null = null;
let label = '';

beforeAll(async () => {
  try {
    await connector.connect();
  } catch {
    return;
  }
  if (process.env['GROQ_API_KEY']) {
    model = await resolveModel({
      provider: 'groq',
      model: process.env['ASKSQL_GROQ_MODEL'] ?? 'llama-3.3-70b-versatile',
      apiKey: process.env['GROQ_API_KEY'],
    });
    label = 'groq';
  } else {
    try {
      const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        model = await resolveModel({
          provider: 'ollama',
          model: 'qwen2.5-coder:14b',
          baseURL: 'http://localhost:11434/v1',
        });
        label = 'ollama';
      }
    } catch {
      /* none */
    }
  }
  if (model)
    engine = createAskSql({
      connectors: [connector],
      model,
      policy: { maxRows: 100 },
      llm: { timeoutMs: label === 'ollama' ? 120_000 : 45_000 },
    });
}, 30_000);

afterAll(async () => {
  await connector.close();
});

/** Ask, run, and return the numeric scalar in row 0 col 0 (or NaN). */
async function scalar(q: string): Promise<{ sql: string; value: number }> {
  const ans = await engine!.ask(q);
  const res = await ans.run();
  return { sql: ans.sql, value: Number(res.rows[0]?.[0]) };
}

const gen = (name: string, fn: () => Promise<void>, timeout = 90_000) =>
  it(
    name,
    async () => {
      if (!engine) {
        console.warn('[skip] gen-quality - no model available');
        return;
      }
      await fn();
    },
    timeout,
  );

describe('relative dates', () => {
  gen('"in the last 90 days" produces a valid date-filtered query', async () => {
    const { sql, value } = await scalar('How many orders were placed in the last 90 days?');
    console.log(`[${label}]`, sql.replace(/\s+/g, ' ').trim());
    // Deterministic invariant: valid SQL that ran and returned a number.
    expect(Number.isFinite(value)).toBe(true);
    expect(sql.toLowerCase()).toMatch(/placed_at|interval|now\(\)|current_date|-\s*90|date/);
  });
});

describe('NULL semantics', () => {
  gen('"customers with no orders" uses NULL-safe logic, not = NULL', async () => {
    const { sql, value } = await scalar('How many customers have never placed an order?');
    console.log(`[${label}]`, sql.replace(/\s+/g, ' ').trim());
    expect(Number.isFinite(value)).toBe(true);
    // Must not use the always-false `= NULL`; should use IS NULL / NOT EXISTS / LEFT JOIN.
    expect(sql.toLowerCase()).not.toMatch(/=\s*null/);
    expect(sql.toLowerCase()).toMatch(/is null|not exists|not in|left join/);
  });
});

describe('typo / synonym tolerance', () => {
  gen('a typo ("custmers") still resolves to the customers table', async () => {
    const ans = await engine!.ask('how many custmers are there?');
    const res = await ans.run();
    console.log(`[${label}]`, ans.sql.replace(/\s+/g, ' ').trim());
    expect(ans.sql.toLowerCase()).toContain('customers');
    expect(Number(res.rows[0]![0])).toBe(3);
  });
});

describe('top-N with implicit metric', () => {
  gen('"top customers" yields an ORDER BY + LIMIT', async () => {
    const ans = await engine!.ask('Who are the top 2 customers?');
    console.log(`[${label}]`, ans.sql.replace(/\s+/g, ' ').trim());
    const res = await ans.run();
    expect(res.rowCount).toBeLessThanOrEqual(2);
    expect(ans.sql.toLowerCase()).toMatch(/order by/);
  });
});

describe('schema question answered from the catalog', () => {
  gen('"which tables reference customers?" produces a valid query or answer', async () => {
    // Either it answers from the catalog or writes a valid information_schema
    // query - both are acceptable; the invariant is no crash + valid output.
    const ans = await engine!.ask('Which columns are in the orders table?');
    console.log(`[${label}]`, ans.sql.replace(/\s+/g, ' ').trim());
    expect(ans.sql.length).toBeGreaterThan(0);
    await ans.run(); // must be runnable + guarded
  });
});

describe('glossary steers a real model', () => {
  gen('a "big order" glossary definition drives the WHERE clause', async () => {
    // Define a business term the schema doesn't name; the model should apply it.
    const glossed = createAskSql({
      connectors: [connector],
      model: model!,
      policy: { maxRows: 100 },
      llm: { timeoutMs: label === 'ollama' ? 120_000 : 45_000 },
      glossary: [{ term: 'big order', definition: 'an order whose total_cents is greater than 100000' }],
    });
    const ans = await glossed.ask('How many big orders are there?');
    console.log(`[${label}]`, ans.sql.replace(/\s+/g, ' ').trim());
    // The glossary threshold should appear in the generated SQL.
    expect(ans.sql).toMatch(/total_cents/);
    expect(ans.sql).toMatch(/100000|100_000/);
    await ans.run();
  });
});
