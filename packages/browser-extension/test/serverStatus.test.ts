import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCommand, probeServer, serveCommand } from '../src/serverStatus.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('probeServer', () => {
  it('is idle for an empty URL, without making a request', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    expect(await probeServer('   ')).toEqual({ kind: 'idle' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports how many databases a running server exposes', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ connections: [{ id: 'a' }, { id: 'b' }] }),
    })) as unknown as typeof fetch;
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'running', databases: 2 });
  });

  it('counts zero databases as running - the server is up, it just has none yet', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ connections: [] }) })) as unknown as typeof fetch;
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'running', databases: 0 });
  });

  it('tolerates a running server whose body is not the expected shape', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error('x')) })) as unknown as typeof fetch;
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'running', databases: 0 });
  });

  it('treats a non-OK response as unreachable', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'unreachable' });
  });

  it('treats a network failure as unreachable rather than throwing into the UI', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'unreachable' });
  });

  it('tolerates a trailing slash on the configured URL', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ connections: [] }) }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await probeServer('http://localhost:3000/');
    expect((spy.mock.calls as unknown as [string][])[0]?.[0]).toBe('http://localhost:3000/connections');
  });
});

describe('serveCommand', () => {
  it('embeds the configured provider and model so it can be copied as-is', () => {
    expect(serveCommand('ollama', 'qwen2.5-coder:14b')).toBe(
      'npx --package=@asksql/server asksql serve --provider ollama --model qwen2.5-coder:14b',
    );
  });

  it('pins the package, because the bin name is not a package name', () => {
    // `npx asksql` resolves to a package called "asksql", which does not exist.
    const cmd = serveCommand('ollama', 'm');
    expect(cmd).toContain('--package=@asksql/server');
    expect(cmd).not.toMatch(/npx asksql\b/);
  });

  it('leaves an obvious placeholder when no model is set yet', () => {
    expect(serveCommand('openai', '  ')).toContain('--model <model-id>');
  });

  it('offers a scoped global install as the npx-free alternative', () => {
    expect(installCommand()).toBe('npm i -g @asksql/server');
  });
});

describe('createRemoteDatabaseConnection when no server is listening', () => {
  it('says what to run instead of the browser\'s bare "Failed to fetch"', async () => {
    const { createRemoteDatabaseConnection } = await import('../src/databaseConnections.js');
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(
      createRemoteDatabaseConnection('http://localhost:3000', undefined, 'x', {
        engine: 'mysql', uri: '', host: 'localhost', port: '3306', database: 'd', user: 'root', password: '', ssl: 'trust',
      }),
    ).rejects.toThrow(/No AskSQL server is reachable.*asksql serve/s);
  });
});
