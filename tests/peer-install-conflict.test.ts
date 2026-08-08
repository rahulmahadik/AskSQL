/**
 * Proves the duplicate-core fix through a real npm install: a consumer pinned to an older core must
 * get an ERESOLVE conflict, not a second core nested under the connector. Workspace links and
 * `tools/packaged-consumer-test.mjs` both hoist one core for everyone, so neither can show this.
 * Offline and file-based: the tarballs are packed here, nothing is fetched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** sqlite: the smallest connector with no required native peer. The manifest test covers the rest. */
const ADAPTER_DIR = join(ROOT, 'packages', 'sqlite');

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let staging: string;
let adapterTarball: string;
let adapterManifest: Record<string, Record<string, string>>;
const consumers: string[] = [];

/** A tarball for @asksql/core at `version`, so no registry is needed to pin an arbitrary version. */
function packCore(version: string): string {
  const dir = join(staging, `core-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@asksql/core', version, type: 'module', main: 'index.js' }),
  );
  writeFileSync(join(dir, 'index.js'), 'export const stub = true;\n');
  run('npm', ['pack', '--pack-destination', staging], dir);
  return join(staging, `asksql-core-${version}.tgz`);
}

function install(deps: Record<string, string>): { dir: string; ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asksql-peer-consumer-'));
  consumers.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'peer-consumer', version: '1.0.0', private: true, dependencies: deps }),
  );
  try {
    return { dir, ok: true, output: run('npm', ['install', '--offline', '--no-audit', '--no-fund'], dir) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { dir, ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

beforeAll(() => {
  staging = mkdtempSync(join(tmpdir(), 'asksql-peer-tarballs-'));
  // pnpm pack, not npm pack: only pnpm rewrites the `workspace:` protocol into the published range.
  const packed = run('pnpm', ['pack', '--pack-destination', staging], ADAPTER_DIR);
  adapterTarball = packed.trim().split('\n').filter(Boolean).pop() as string;
  adapterManifest = JSON.parse(run('tar', ['-xzOf', adapterTarball, 'package/package.json'], staging));
}, 120_000);

afterAll(() => {
  for (const dir of [staging, ...consumers]) rmSync(dir, { recursive: true, force: true });
});

describe('a consumer pinned to another core version gets a conflict, not a second core', () => {
  it('publishes the core peer as a plain semver range', () => {
    expect(adapterManifest['peerDependencies']?.['@asksql/core']).toBe('>=0.6.0');
    expect(adapterManifest['dependencies']?.['@asksql/core']).toBeUndefined();
  });

  it('fails with ERESOLVE against a core the peer range excludes', { timeout: 120_000 }, () => {
    const core = packCore('0.5.0');
    const { dir, ok, output } = install({
      '@asksql/core': `file:${core}`,
      '@asksql/sqlite': `file:${adapterTarball}`,
    });
    expect(ok, `npm accepted the tree instead of reporting a conflict:\n${output}`).toBe(false);
    expect(output).toContain('ERESOLVE');
    expect(output).toContain('peer @asksql/core@">=0.6.0" from @asksql/sqlite');
    expect(
      existsSync(join(dir, 'node_modules', '@asksql', 'sqlite', 'node_modules', '@asksql', 'core')),
      'a second core was installed under the connector',
    ).toBe(false);
  });

  it('installs a single shared core when the pin satisfies the range', { timeout: 120_000 }, () => {
    const core = packCore('0.6.1');
    const { dir, ok, output } = install({
      '@asksql/core': `file:${core}`,
      '@asksql/sqlite': `file:${adapterTarball}`,
    });
    expect(ok, output).toBe(true);
    const installed = JSON.parse(
      readFileSync(join(dir, 'node_modules', '@asksql', 'core', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(installed.version).toBe('0.6.1');
    expect(existsSync(join(dir, 'node_modules', '@asksql', 'sqlite', 'node_modules'))).toBe(false);
  });
});
