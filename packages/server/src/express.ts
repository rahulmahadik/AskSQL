/**
 * Express adapter - mount the AskSQL sidecar in an existing app:
 *
 * app.use('/asksql', asksqlMiddleware({ connectors, engine, auth }))
 *
 * Streams /chat as SSE with heartbeats + no-buffering headers so it
 * survives reverse proxies.
 */

import { AskSqlError } from '@asksql/core';
import { AskSqlServer, isStream, type HandlerResponse } from './handler.js';
import type { AskSqlServerConfig, ServerRequest } from './types.js';

interface ExpressLikeReq {
  method: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body?: unknown;
  on(event: string, cb: (chunk?: unknown) => void): void;
}
interface ExpressLikeRes {
  statusCode: number;
  setHeader(k: string, v: string): void;
  write(chunk: string): void;
  end(body?: string): void;
  flushHeaders?(): void;
}
type Next = (err?: unknown) => void;

export type ExpressMiddleware = (req: ExpressLikeReq, res: ExpressLikeRes, next: Next) => void;

export interface ExpressAdapterOptions {
  /**
   * CORS for cross-origin frontends. Pass `true` to reflect the
   * request Origin, or a fixed origin / list of allowed origins. Omit for
   * same-origin deployments (no CORS headers emitted).
   */
  readonly cors?: boolean | string | readonly string[];
  /** Header the client sends auth in; echoed in Allow-Headers. Default common set. */
  readonly allowHeaders?: readonly string[];
}

export function asksqlMiddleware(
  config: AskSqlServerConfig,
  adapter: ExpressAdapterOptions = {},
): ExpressMiddleware {
  const server = new AskSqlServer(config);

  const applyCors = (req: ExpressLikeReq, res: ExpressLikeRes): void => {
    if (adapter.cors === undefined || adapter.cors === false) return;
    const origin = String(req.headers['origin'] ?? '');
    let allow: string | null = null;
    // `credentialed` is true ONLY when the request origin matched an explicit
    // allowlist. Never combine a reflected/`*` origin with Allow-Credentials -
    // that lets any site make credentialed cross-origin calls (a classic CORS
    // misconfig). `cors: true` reflects the origin but WITHOUT credentials.
    let credentialed = false;
    if (adapter.cors === true) {
      allow = origin || '*';
  } else if (typeof adapter.cors === 'string') {
  if (adapter.cors === '*') allow = '*';
  else if (adapter.cors === origin) { allow = origin; credentialed = true; }
  } else if (Array.isArray(adapter.cors)) {
  if (adapter.cors.includes(origin)) { allow = origin; credentialed = true; }
  }
    if (!allow) return;
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      (adapter.allowHeaders ?? ['Content-Type', 'Authorization', 'X-User']).join(', '),
    );
  if (credentialed) res.setHeader('Access-Control-Allow-Credentials', 'true');
  };

  return (req, res, next) => {
    void (async () => {
      applyCors(req, res);
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
    const sreq = toServerRequest(req, server.maxBodyBytes);
      let response: HandlerResponse;
      try {
        response = await server.handle(sreq);
      } catch (err) {
        next(err);
        return;
      }

      if (isStream(response)) {
        res.statusCode = response.status;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // defeat nginx buffering
        res.flushHeaders?.();
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 10_000);
        try {
          for await (const event of response.stream) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        } finally {
          clearInterval(heartbeat);
          res.end();
        }
        return;
      }

      res.statusCode = response.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(response.body));
    })();
  };
}

function toServerRequest(req: ExpressLikeReq, maxBodyBytes: number): ServerRequest {
  const rawPath = req.path ?? (req.originalUrl ?? req.url ?? '/').split('?')[0]!;
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) {
    query[k] = Array.isArray(v) ? String(v[0]) : v === undefined ? undefined : String(v);
  }
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    headers[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : v === undefined ? undefined : String(v);
  }

  return {
    method: req.method,
    path: rawPath,
    query,
    headers,
    json: async () => {
      // Prefer body-parser output when present; else read the raw stream.
      if (req.body !== undefined && req.body !== null && req.body !== '') return req.body;
      return await readRawJson(req, maxBodyBytes);
    },
  };
}

function readRawJson(req: ExpressLikeReq, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (c) => {
        if (aborted) return;
        const buf = Buffer.from(c as Buffer);
        total += buf.length;
        // Bound memory: reject once the body exceeds the configured cap instead
        // of buffering an arbitrarily large request (memory DoS).
        if (total > maxBytes) {
          aborted = true;
          reject(new AskSqlError('INVALID_INPUT', { userMessage: 'The request body is too large.', detail: `body exceeded ${maxBytes} bytes` }));
          return;
    }
  chunks.push(buf);
  });
    req.on('end', () => {
        if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
