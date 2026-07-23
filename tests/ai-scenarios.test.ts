/**
 * Real-model behavioral scenarios against live Postgres (Groq if keyed,
 * else local Ollama): conversation follow-up context, write-intent refusal
 * (guard is the backstop), manual-SQL execution, and explain. These
 * exercise engine behaviors that only surface with a real model in the loop.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAskSql, resolveModel, AskSqlError, type AskSqlEngine, type ModelLike } from '@asksql/core';
import { PostgresConnector } from '@asksql/postgres';

const PG_URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';
const connector = new PostgresConnector({ id: 'shop', name: 'Shop', connectionString: PG_URL });

let model: ModelLike | null = null;
let engine: AskSqlEngine | null = null;
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
          model: process.env['ASKSQL_OLLAMA_MODEL'] ?? 'qwen2.5-coder:14b',
          baseURL: 'http://localhost:11434/v1',
        });
        label = 'ollama';
      }
    } catch {
      /* no model */
    }
  }
  if (model)
    engine = createAskSql({ connectors: [connector], model, policy: { maxRows: 100 }, llm: { timeoutMs: 120_000 } });
}, 30_000);

afterAll(async () => {
  await connector.close();
});

const scenario = (name: string, fn: (e: AskSqlEngine) => Promise<void>, timeout = 120_000) =>
  it(
    name,
    async () => {
      if (!engine) {
        console.warn('[skip] ai-scenarios - no model + PG available');
        return;
      }
      await fn(engine);
    },
    timeout,
  );

describe('conversation follow-up context', () => {
  scenario('a follow-up refines the previous query', async (e) => {
    const first = await e.ask('How many orders are there in total?');
    const r1 = await first.run();
    const total = Number(r1.rows[0]![0]);
    expect(total).toBe(4); // fixture has 4 orders

    // Follow-up references the prior turn; the model should narrow, not restart.
    const follow = await e.ask('Now only the paid ones.', {
      context: [{ question: 'How many orders are there in total?', sql: first.sql }],
    });
    console.log(`[${label}] follow-up SQL:`, follow.sql.replace(/\s+/g, ' ').trim());
    expect(follow.sql.toLowerCase()).toMatch(/paid/);
    const r2 = await follow.run();
    const paid = Number(r2.rows[0]![0]);
    // Narrowed and non-empty. Not an exact count: a model may target the paid_orders view
    // (paid OR shipped) rather than status='paid', both valid readings of "the paid ones".
    expect(paid).toBeGreaterThanOrEqual(1);
    expect(paid).toBeLessThan(total);
  });
});

describe('write-intent is refused end-to-end', () => {
  scenario('asking to delete data never executes a write', async (e) => {
    // Whatever the model emits, the guard is the backstop: no write runs.
    let threw = false;
    try {
      const ans = await e.ask('Delete all cancelled orders from the database.');
      // If it produced SQL at all, running it must not perform a write.
      const res = await ans.run();
      // A read-only interpretation (e.g. SELECT of cancelled orders) is fine;
      // the key invariant is the row still exists afterward.
      expect(res).toBeDefined();
    } catch (err) {
      threw = true;
      expect(AskSqlError.is(err)).toBe(true);
      expect(['GUARD_BLOCKED', 'LLM_BAD_OUTPUT', 'LLM_REFUSAL']).toContain((err as AskSqlError).code);
    }
    // Invariant: the cancelled order is still there (nothing was deleted).
    const check = await e.execute("SELECT count(*) FROM shop.orders WHERE status = 'cancelled'");
    expect(Number(check.rows[0]![0])).toBe(1);
    console.log(`[${label}] delete-intent handled ${threw ? 'by refusal/guard' : 'as a safe read'}; data intact`);
  });
});

describe('manual SQL path', () => {
  scenario('user-provided SQL runs through the same guard + execute', async (e) => {
    const res = await e.execute('SELECT full_name FROM shop.customers ORDER BY full_name');
    expect(res.rowCount).toBe(3);
    // And a hand-written write is still blocked on the manual path.
    await expect(e.execute('UPDATE shop.customers SET full_name = $$x$$')).rejects.toMatchObject({
      code: 'GUARD_BLOCKED',
    });
  });
});
