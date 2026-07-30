/** Probes whether an AskSQL server is listening. Deliberately never requests host permission (opening Settings must not raise a prompt), so an ungranted origin simply reads as unreachable. */
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

/**
 * The bin is `asksql` but the package is `@asksql/server`, so a bare
 * `npx asksql` resolves to a package that does not exist. `--package` pins the
 * package and names the bin separately.
 */
export function serveCommand(provider: string, model: string): string {
  const m = model.trim() || '<model-id>';
  return `npx --package=@asksql/server asksql serve --provider ${provider} --model ${m}`;
}

/** For anyone who would rather install once than use npx (works with npm, pnpm, yarn). */
export function installCommand(): string {
  return 'npm i -g @asksql/server';
}
