import { describe, expect, it, vi } from 'vitest';
import { buildServer, CliError, main, parseArgs, USAGE } from '../src/cli.js';

const base = ['--model', 'qwen2.5-coder:14b'];

describe('parseArgs', () => {
  it('defaults to a loopback-only ollama server', () => {
    const o = parseArgs(base);
    expect(o).toMatchObject({ host: '127.0.0.1', port: 3000, provider: 'ollama', model: 'qwen2.5-coder:14b', maxRows: 200 });
  });

  it('accepts `serve` as a leading subcommand', () => {
    expect(parseArgs(['serve', ...base]).model).toBe('qwen2.5-coder:14b');
  });

  it('reads every option', () => {
    const o = parseArgs([
      ...base, '--port', '8080', '--provider', 'openai', '--base-url', 'https://x/v1',
      '--api-key', 'sk-1', '--max-rows', '50', '--host', '0.0.0.0', '--allow-host', 'db1', '--allow-host', 'db2',
    ]);
    expect(o).toMatchObject({ port: 8080, provider: 'openai', baseURL: 'https://x/v1', apiKey: 'sk-1', maxRows: 50 });
    expect(o.allowedHosts).toEqual(['db1', 'db2']);
  });

  it('requires a model, since there is no safe default to guess', () => {
    expect(() => parseArgs([])).toThrow(CliError);
    expect(() => parseArgs([])).toThrow(/--model is required/);
  });

  it('refuses to listen publicly without saying which databases are allowed', () => {
    expect(() => parseArgs([...base, '--host', '0.0.0.0'])).toThrow(/Refusing to listen/);
    expect(() => parseArgs([...base, '--host', '0.0.0.0', '--allow-host', 'db'])).not.toThrow();
  });

  it('still allows the loopback aliases without an allowlist', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(() => parseArgs([...base, '--host', host])).not.toThrow();
    }
  });

  it.each(['--port', '--model', '--host', '--allow-host', '--max-rows'])('rejects %s with no value', (flag) => {
    expect(() => parseArgs([flag])).toThrow(/needs a value/);
    expect(() => parseArgs([flag, '--other'])).toThrow(/needs a value/);
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejects a non-positive-integer port (%s)', (v) => {
    expect(() => parseArgs([...base, '--port', v])).toThrow(/positive whole number/);
  });

  it('names the offending flag and shows usage for an unknown option', () => {
    expect(() => parseArgs([...base, '--nope'])).toThrow(/Unknown option: --nope/);
  });

  it('documents every flag it accepts', () => {
    for (const flag of ['--port', '--host', '--provider', '--model', '--base-url', '--api-key', '--allow-host', '--max-rows']) {
      expect(USAGE).toContain(flag);
    }
  });
});

describe('buildServer', () => {
  it('starts with no databases and accepts them at runtime, which is the point of serving', async () => {
    // resolveModel for ollama only constructs a client - no network call here.
    const server = await buildServer(parseArgs([...base, '--max-rows', '25']));
    const res = (await server.handle({
      method: 'GET', path: '/connections', query: {}, headers: {}, json: async () => ({}),
    })) as { status: number; body: { connections: unknown[] } };

    expect(res.status).toBe(200);
    expect(res.body.connections).toEqual([]);
  });

  it('passes the host allowlist through, so the server refuses databases outside it', async () => {
    const server = await buildServer(parseArgs([...base, '--host', '0.0.0.0', '--allow-host', 'db.internal']));
    const res = (await server.handle({
      method: 'POST', path: '/connections', query: {}, headers: {},
      json: async () => ({ name: 'x', engine: 'mysql', host: 'elsewhere.example', database: 'd' }),
    })) as { status: number; body: { error?: { userMessage: string } } };

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.userMessage).toMatch(/not allowed to connect/i);
  });
});

describe('main', () => {
  it('prints usage for --help without starting a server', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(log.mock.calls[0]?.[0]).toContain('asksql serve');
    log.mockRestore();
  });
});
