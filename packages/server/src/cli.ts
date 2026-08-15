/** `asksql serve` - a ready-to-run local sidecar for anything speaking the HTTP contract (e.g. the browser extension). Binds 127.0.0.1 by default; a non-loopback --host is refused without --allow-host. */
import http from 'node:http';
import { AskSqlServer, isStream } from './handler.js';
import { ANY_CONNECTION } from './handler.js';
import type { ProviderName } from '@asksql/core';

export interface CliOptions {
  readonly port: number;
  readonly host: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly allowedHosts?: readonly string[];
  readonly maxRows: number;
}

export class CliError extends Error {}

const DEFAULTS = { port: 3000, host: '127.0.0.1', provider: 'ollama' as ProviderName, maxRows: 200 };

export const USAGE = `asksql serve - run a local AskSQL server

  --port <n>            Port to listen on (default ${DEFAULTS.port})
  --host <addr>         Interface to bind (default ${DEFAULTS.host}, i.e. this machine only)
  --provider <name>     ollama | openai | anthropic | google | azure | groq | nvidia | openai-compatible
                        (default ${DEFAULTS.provider})
  --model <id>          Model id, e.g. qwen2.5-coder:7b or gpt-5
  --base-url <url>      Provider endpoint override
  --api-key <key>       Provider API key (or set ASKSQL_API_KEY)
  --allow-host <host>   Only let clients open databases on this host. Repeatable.
                        Required when --host is not loopback.
  --max-rows <n>        Row cap per query (default ${DEFAULTS.maxRows})
  --help

Databases are added by the client at runtime (the browser extension's
connection form), so no database details are needed here.`;

/**
 * Addresses that reach this machine only. The whole 127/8 block is loopback, not just 127.0.0.1,
 * and --host takes an IPv6 address either bracketed or bare.
 */
function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && v4.slice(1).every((o) => Number(o) <= 255);
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const allowedHosts: string[] = [];
  let port = DEFAULTS.port;
  let host = DEFAULTS.host;
  let provider = DEFAULTS.provider;
  let maxRows = DEFAULTS.maxRows;
  let model = '';
  let baseURL: string | undefined;
  let apiKey: string | undefined = process.env['ASKSQL_API_KEY'];

  const needValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} needs a value.`);
    return value;
  };
  const needNumber = (flag: string, value: string | undefined): number => {
    const n = Number(needValue(flag, value));
    if (!Number.isInteger(n) || n <= 0) throw new CliError(`${flag} must be a positive whole number.`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--port':
        port = needNumber(arg, argv[++i]);
        break;
      case '--host':
        host = needValue(arg, argv[++i]);
        break;
      case '--provider':
        provider = needValue(arg, argv[++i]) as ProviderName;
        break;
      case '--model':
        model = needValue(arg, argv[++i]);
        break;
      case '--base-url':
        baseURL = needValue(arg, argv[++i]);
        break;
      case '--api-key':
        apiKey = needValue(arg, argv[++i]);
        break;
      case '--allow-host':
        allowedHosts.push(needValue(arg, argv[++i]));
        break;
      case '--max-rows':
        maxRows = needNumber(arg, argv[++i]);
        break;
      case 'serve':
        break; // allow `asksql serve` as well as bare flags
      default:
        throw new CliError(`Unknown option: ${arg}\n\n${USAGE}`);
    }
  }

  if (!model) throw new CliError(`--model is required.\n\n${USAGE}`);
  if (!isLoopback(host) && allowedHosts.length === 0) {
    throw new CliError(
      `Refusing to listen on ${host} while any client could ask this server to open any database.\n` +
        `Add --allow-host <db-host> (repeatable) to say which databases are permitted, or drop --host to stay on ${DEFAULTS.host}.`,
    );
  }

  return {
    port,
    host,
    provider,
    model,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    maxRows,
  };
}

/** Adapts node:http onto the framework-agnostic handler, including the SSE shape /chat streams. */
export function createRequestListener(server: AskSqlServer): http.RequestListener {
  return (req, res) => {
    void (async () => {
      try {
        // The configured cap, not a hardcoded one: this is the transport the browser extension uses,
        // and maxBodyBytes was silently ignored here while the Express adapter honoured it.
        const MAX_BODY_BYTES = server.maxBodyBytes ?? 10 * 1024 * 1024;
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        for await (const chunk of req) {
          bodyBytes += (chunk as Buffer).length;
          if (bodyBytes > MAX_BODY_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'INVALID_INPUT', userMessage: 'Request body too large.' } }));
            req.destroy();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://localhost');

        // Cancel when the RESPONSE closes early; the request stream also emits 'close' on a normal body read.
        const aborted = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) aborted.abort();
        });

        const response = await server.handle({
          method: req.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
          json: async () => (bodyText ? (JSON.parse(bodyText) as unknown) : {}),
          signal: aborted.signal,
        });

        if (isStream(response)) {
          res.writeHead(response.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          // Stop pulling the stream once the client aborts; writes to a closed response are dropped silently.
          for await (const event of response.stream) {
            if (aborted.signal.aborted) break;
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          res.end();
          return;
        }
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response.body));
      } catch (err) {
        // The handler maps its own errors, so reaching here means the adapter failed; still answer.
        console.error('AskSQL: request failed', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: { code: 'INTERNAL', userMessage: 'The server failed to handle that request.' } }),
        );
      }
    })();
  };
}

export async function buildServer(options: CliOptions): Promise<AskSqlServer> {
  const { resolveModel } = await import('@asksql/core');
  const model = await resolveModel({
    provider: options.provider,
    model: options.model,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  return new AskSqlServer({
    connectors: [],
    dynamicConnections: {
      enabled: true,
      ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
      // A client names a server-side file path. That is the machine's own user on a loopback
      // bind, and an unknown caller on any other, so the file engines are refused there.
      allowFileEngines: isLoopback(options.host),
    },
    engine: { model, policy: { maxRows: options.maxRows } },
    // Single-user local sidecar: the process boundary is the trust boundary.
    auth: () => ({ userId: 'local', allowedConnectionIds: [ANY_CONNECTION] }),
    requireLoopbackHost: isLoopback(options.host),
  });
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const options = parseArgs(argv);
  const server = await buildServer(options);
  const httpServer = http.createServer(createRequestListener(server));
  await new Promise<void>((resolve) => httpServer.listen(options.port, options.host, resolve));

  console.log(`AskSQL server listening on http://${options.host}:${options.port}`);
  console.log(`  model: ${options.provider} / ${options.model}`);
  console.log(
    `  databases: added by the client at runtime${options.allowedHosts ? ` (limited to ${options.allowedHosts.join(', ')})` : ''}`,
  );
  console.log(`\nPoint the AskSQL browser extension at http://${options.host}:${options.port}`);
}
