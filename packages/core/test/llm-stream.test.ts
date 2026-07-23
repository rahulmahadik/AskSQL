/**
 * callModel over a CustomModel: the async-iterable streaming branch, the
 * one-shot resend without temperature when a provider rejects it, and
 * caller-cancellation mid-stream.
 */

import { describe, expect, it } from 'vitest';
import { callModel } from '../src/llm.js';
import type { CustomModel } from '../src/types.js';

describe('callModel with a CustomModel', () => {
  it('streams an async-iterable, emitting each chunk and accumulating the text', async () => {
    const model: CustomModel = async function* () {
      yield 'SELECT ';
      yield '1';
    };
    const tokens: string[] = [];
    const result = await callModel({ model, system: 's', prompt: 'p', onToken: (t) => tokens.push(t) });
    expect(result.text).toBe('SELECT 1');
    expect(tokens).toEqual(['SELECT ', '1']);
  });

  it('emits a single-string result through onToken', async () => {
    const model: CustomModel = async () => 'done';
    const tokens: string[] = [];
    const result = await callModel({ model, system: 's', prompt: 'p', onToken: (t) => tokens.push(t) });
    expect(result.text).toBe('done');
    expect(tokens).toEqual(['done']);
  });

  it('resends once without temperature when the provider rejects it, without spending a retry', async () => {
    let calls = 0;
    const model: CustomModel = () => {
      calls++;
      if (calls === 1) {
        return Promise.reject(
          Object.assign(new Error("This model does not support 'temperature'."), { statusCode: 400 }),
        );
      }
      return Promise.resolve('recovered');
    };
    const result = await callModel({ model, system: 's', prompt: 'p', settings: { maxRetries: 0, timeoutMs: 5000 } });
    expect(result.text).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('cancels mid-stream when the caller aborts', async () => {
    const controller = new AbortController();
    const model: CustomModel = async function* () {
      yield 'part';
      controller.abort();
      yield 'never';
    };
    await expect(
      callModel({ model, system: 's', prompt: 'p', signal: controller.signal, settings: { timeoutMs: 5000 } }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
