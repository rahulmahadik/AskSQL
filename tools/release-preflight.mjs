/**
 * Stops a release from bumping a package to a major nobody asked for: changesets majors any
 * package whose PEER dependency gets a non-patch bump, which once turned a `minor` changeset into
 * `@asksql/server@1.0.0`. Runs before `changeset version`, since npm versions cannot be taken back.
 *
 * Exit codes: 0 fine, 1 a package would be majored without a changeset asking for it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

/** Bump types each changeset explicitly asks for: { '@asksql/core': Set('minor'), ... } */
function declaredBumps() {
  const declared = new Map();
  const dir = join(root, '.changeset');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    const text = readFileSync(join(dir, file), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!front) continue;
    for (const line of front[1].split(/\r?\n/)) {
      const m = /^\s*['"]?([^'":]+)['"]?\s*:\s*(major|minor|patch)\s*$/.exec(line);
      if (!m) continue;
      const [, name, type] = m;
      if (!declared.has(name)) declared.set(name, new Set());
      declared.get(name).add(type);
    }
  }
  return declared;
}

function releasePlan() {
  const dir = mkdtempSync(join(tmpdir(), 'asksql-preflight-'));
  const out = join(dir, 'plan.json');
  try {
    execFileSync('npx', ['changeset', 'status', `--output=${out}`], { cwd: root, stdio: 'pipe' });
    return JSON.parse(readFileSync(out, 'utf8')).releases ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const declared = declaredBumps();
const plan = releasePlan();
const surprises = plan.filter((r) => r.type === 'major' && !declared.get(r.name)?.has('major'));

if (surprises.length > 0) {
  console.error('\nRelease preflight FAILED - a major version bump nobody asked for:\n');
  for (const r of surprises) {
    console.error(`  ${r.name}: ${r.oldVersion} -> ${r.newVersion}`);
    const asked = [...(declared.get(r.name) ?? [])].join(', ') || 'nothing (bumped only as a dependent)';
    console.error(`    the changesets ask for: ${asked}`);
  }
  console.error(
    '\nUsually this is the peer-dependency rule: changesets majors any package whose peerDependency\n' +
      'gets a non-patch bump. Check packages/*/package.json peerDependencies, and that\n' +
      '.changeset/config.json still sets onlyUpdatePeerDependentsWhenOutOfRange.\n' +
      'If the major IS intended, say so in a changeset and this passes.\n',
  );
  process.exit(1);
}

const majors = plan.filter((r) => r.type === 'major');
console.log(
  `Release preflight OK - ${plan.filter((r) => r.type !== 'none').length} packages to release` +
    (majors.length ? `, including ${majors.length} intended major(s).` : ', no majors.'),
);
