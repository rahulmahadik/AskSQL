/** Probes whether an AskSQL server is listening. Deliberately never requests host permission (opening Settings must not raise a prompt), so an ungranted origin simply reads as unreachable. */

import type { ProviderSettings } from './storage.js';

export type ServerState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'running'; readonly databases: number }
  | { readonly kind: 'unreachable' };

const PROBE_TIMEOUT_MS = 3000;

export async function probeServer(baseUrl: string): Promise<ServerState> {
  const url = baseUrl.trim();
  if (!url) return { kind: 'idle' };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/connections`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: 'unreachable' };
    const body = (await res.json().catch(() => null)) as { connections?: unknown[] } | null;
    return { kind: 'running', databases: body?.connections?.length ?? 0 };
  } catch {
    return { kind: 'unreachable' };
  }
}

/** Single-quotes anything a shell would otherwise split, expand or read as a redirection. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9._:/@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The bin is `asksql` but the package is `@asksql/server`, so `--package` pins
 * the package and names the bin separately. The key travels as an environment
 * variable rather than an argument, which `ps` shows to every local user.
 */
export function serveCommand(provider: ProviderSettings): string {
  const model = provider.model.trim() || 'YOUR_MODEL_ID';
  const flags = [`--provider ${provider.provider}`, `--model ${shellArg(model)}`];
  const baseURL = provider.baseURL?.trim();
  if (baseURL) flags.push(`--base-url ${shellArg(baseURL)}`);
  const apiKey = provider.apiKey?.trim();
  const prefix = apiKey ? `ASKSQL_API_KEY=${shellArg(apiKey)} ` : '';
  return `${prefix}npx --package=@asksql/server asksql serve ${flags.join(' ')}`;
}

/** For anyone who would rather install once than use npx (works with npm, pnpm, yarn). */
export function installCommand(): string {
  return 'npm i -g @asksql/server';
}
