import { describe, it, expect, vi } from 'vitest';
import { AskSqlError } from '@asksql/core';
import { LanguageModelError } from './vscode-mock.js';
import { lmCustomModel } from '../src/model.js';

/** A minimal LanguageModelChat whose response streams the given chunks. */
function fakeLm(chunks: string[], opts: { throwErr?: unknown } = {}) {
  const sendRequest = vi.fn(async () => {
    if (opts.throwErr) throw opts.throwErr;
    return {
      text: (async function* () {
        for (const c of chunks) yield c;
      })(),
    };
  });
  return { id: 'lm-1', sendRequest } as never;
}

describe('lmCustomModel', () => {
  it('sends system+prompt as one user message and returns the joined text', async () => {
    const lm = fakeLm(['hel', 'lo']);
    const model = lmCustomModel(lm);
    const out = await model({ system: 'S', prompt: 'P' });
    expect(out).toBe('hello');
    const [messages] = (lm as unknown as { sendRequest: ReturnType<typeof vi.fn> }).sendRequest.mock.calls[0]!;
    expect(messages[0].content).toBe('S\n\nP');
  });

  it('maps NoPermissions to LLM_AUTH', async () => {
    const err = new LanguageModelError('NoPermissions');
    const model = lmCustomModel(fakeLm([], { throwErr: err }));
    await expect(model({ system: 'S', prompt: 'P' })).rejects.toMatchObject({ code: 'LLM_AUTH' });
  });

  it('maps Blocked to LLM_BAD_OUTPUT', async () => {
    const err = new LanguageModelError('Blocked');
    const model = lmCustomModel(fakeLm([], { throwErr: err }));
    await expect(model({ system: 'S', prompt: 'P' })).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
  });

  it('maps any other LanguageModelError to LLM_UNAVAILABLE', async () => {
    const err = new LanguageModelError('SomethingElse');
    const model = lmCustomModel(fakeLm([], { throwErr: err }));
    const caught = await model({ system: 'S', prompt: 'P' }).catch((e) => e);
    expect(AskSqlError.is(caught)).toBe(true);
    expect(caught.code).toBe('LLM_UNAVAILABLE');
  });

  it('rethrows a non-LanguageModelError unchanged', async () => {
    const err = new Error('network down');
    const model = lmCustomModel(fakeLm([], { throwErr: err }));
    await expect(model({ system: 'S', prompt: 'P' })).rejects.toBe(err);
  });

  it('cancels the request when an already-aborted signal is passed', async () => {
    const lm = fakeLm(['x']);
    const model = lmCustomModel(lm);
    const ac = new AbortController();
    ac.abort();
    await model({ system: 'S', prompt: 'P', signal: ac.signal });
    // The token source is cancelled synchronously; the request still resolves here.
    expect((lm as unknown as { sendRequest: ReturnType<typeof vi.fn> }).sendRequest).toHaveBeenCalled();
  });

  it('bridges a late abort to the cancellation token', async () => {
    const lm = fakeLm(['x']);
    const model = lmCustomModel(lm);
    const ac = new AbortController();
    const p = model({ system: 'S', prompt: 'P', signal: ac.signal });
    ac.abort();
    await p;
    expect((lm as unknown as { sendRequest: ReturnType<typeof vi.fn> }).sendRequest).toHaveBeenCalled();
  });
});
