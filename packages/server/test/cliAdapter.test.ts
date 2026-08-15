import { describe, expect, it, vi } from 'vitest';
import { createRequestListener } from '../src/cli.js';
import type { AskSqlServer, HandlerResponse } from '../src/handler.js';

/** Minimal node:http stand-ins - the adapter only touches these members. */
function fakeReq(method: string, url: string, body = '') {
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function fakeRes() {
  const closeCbs: (() => void)[] = [];
  return {
    headersSent: false,
    closeCbs,
    on(event: string, cb: () => void) {
      if (event === 'close') closeCbs.push(cb);
    },
    fireClose() {
      closeCbs.forEach((cb) => cb());
    },
    status: 0,
    headers: { 'content-type': 'application/json' } as Record<string, string>,
    chunks: [] as string[],
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(c: string) {
      this.chunks.push(c);
    },
    end(c?: string) {
      if (c) this.chunks.push(c);
    },
  };
}

const listenerFor = (handle: (req: unknown) => Promise<HandlerResponse>) =>
  createRequestListener({ handle } as unknown as AskSqlServer);

const settled = () => new Promise((r) => setImmediate(r));

describe('createRequestListener', () => {
  it('passes method, path, query, headers and parsed body through to the handler', async () => {
    const handle = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const res = fakeRes();
    listenerFor(handle)(fakeReq('POST', '/execute?connectionId=c1', '{"sql":"SELECT 1"}') as never, res as never);
    await settled();

    const passed = handle.mock.calls[0]![0] as {
      method: string;
      path: string;
      query: Record<string, string>;
      json: () => Promise<unknown>;
    };
    expect(passed.method).toBe('POST');
    expect(passed.path).toBe('/execute');
    expect(passed.query).toEqual({ connectionId: 'c1' });
    await expect(passed.json()).resolves.toEqual({ sql: 'SELECT 1' });
  });

  it('treats an empty body as {} rather than failing to parse', async () => {
    const handle = vi.fn(async () => ({ status: 200, body: {} }));
    listenerFor(handle)(fakeReq('GET', '/connections') as never, fakeRes() as never);
    await settled();
    const passed = handle.mock.calls[0]![0] as { json: () => Promise<unknown> };
    await expect(passed.json()).resolves.toEqual({});
  });

  it('writes a JSON response with the handler status', async () => {
    const res = fakeRes();
    listenerFor(async () => ({ status: 201, body: { connection: { id: 'dyn_1' } } }))(
      fakeReq('POST', '/connections') as never,
      res as never,
    );
    await settled();

    expect(res.status).toBe(201);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.chunks.join(''))).toEqual({ connection: { id: 'dyn_1' } });
  });

  it('streams a chat response as server-sent events, one event per line', async () => {
    const res = fakeRes();
    const stream = (async function* () {
      yield { type: 'stage', stage: 'LLM' };
      yield { type: 'sql', sql: 'SELECT 1' };
    })();
    listenerFor(async () => ({ status: 200, stream }) as unknown as HandlerResponse)(
      fakeReq('POST', '/chat') as never,
      res as never,
    );
    await settled();

    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.chunks).toEqual([
      'data: {"type":"stage","stage":"LLM"}\n\n',
      'data: {"type":"sql","sql":"SELECT 1"}\n\n',
    ]);
  });

  it('answers 500 instead of hanging the socket when the adapter itself throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    listenerFor(async () => {
      throw new Error('boom');
    })(fakeReq('GET', '/connections') as never, res as never);
    await settled();

    expect(res.status).toBe(500);
    expect(JSON.parse(res.chunks.join('')).error.code).toBe('INTERNAL');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
  it('answers 413 and stops buffering when the body exceeds the cap', async () => {
    const handle = vi.fn(async () => ({ status: 200, body: {} }));
    const res = fakeRes();
    const big = {
      method: 'POST',
      url: '/execute',
      headers: { 'content-type': 'application/json' },
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(6 * 1024 * 1024);
        yield Buffer.alloc(6 * 1024 * 1024);
      },
    };
    listenerFor(handle)(big as never, res as never);
    await settled();

    expect(res.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
    expect(big.destroyed).toBe(true);
  });

  it('honours the configured maxBodyBytes, not a hardcoded ceiling', async () => {
    // The CLI adapter is the transport the browser extension uses, and it ignored the setting the
    // Express adapter honoured, so a tightened cap did nothing here.
    const handle = vi.fn(async () => ({ status: 200, body: {} }));
    const res = fakeRes();
    const req = {
      method: 'POST',
      url: '/execute',
      headers: { 'content-type': 'application/json' },
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(2048);
      },
    };
    createRequestListener({ handle, maxBodyBytes: 1024 } as unknown as AskSqlServer)(req as never, res as never);
    await settled();

    expect(res.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
  });

  it('stops pulling the stream once the client disconnects mid-SSE', async () => {
    const res = fakeRes();
    let pulled = 0;
    const stream = {
      async *[Symbol.asyncIterator]() {
        pulled++;
        yield { type: 'stage', stage: 'LLM' };
        res.fireClose();
        pulled++;
        yield { type: 'token', text: 'never written' };
        pulled++;
        yield { type: 'done' };
      },
    };
    listenerFor(async () => ({ status: 200, stream }) as unknown as HandlerResponse)(
      fakeReq('POST', '/chat') as never,
      res as never,
    );
    await settled();

    expect(res.chunks.join('')).toContain('"stage":"LLM"');
    expect(res.chunks.join('')).not.toContain('never written');
    expect(pulled).toBeLessThan(3);
  });
});
