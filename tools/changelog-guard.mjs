/**
 * Fails when a surface's version has no CHANGELOG section of its own.
 *
 * The npm packages get theirs from changesets. The three hand-versioned surfaces do not, and every
 * one of them shipped a release this month with features missing from its notes: the plugin lost
 * the glossary, the charts and the copyable SQL block, VS Code's Unreleased section was empty
 * while it gained Azure, and the browser extension never mentioned Azure at all.
 *
 *   node tools/changelog-guard.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const jsonVersion = (file) => JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')).version;
const gradleVersion = (file) =>
  readFileSync(resolve(ROOT, file), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('pluginVersion'))
    ?.split('=')[1]
    ?.trim();

const SURFACES = [
  {
    name: 'VS Code extension',
    version: () => jsonVersion('packages/vscode/package.json'),
    changelog: 'packages/vscode/CHANGELOG.md',
  },
  {
    name: 'JetBrains plugin',
    version: () => gradleVersion('packages/jetbrains/gradle.properties'),
    changelog: 'packages/jetbrains/CHANGELOG.md',
  },
  {
    name: 'Browser extension',
    version: () => jsonVersion('packages/browser-extension/package.json'),
    changelog: 'packages/browser-extension/CHANGELOG.md',
  },
];

/** A heading counts when the version appears in it, bracketed or bare. */
function hasSection(changelog, version) {
  return readFileSync(resolve(ROOT, changelog), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .some((l) => l.includes(`[${version}]`) || new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}\\b`).test(l));
}

/** Everything between this version's heading and the next one, minus headings and blanks. */
function sectionBody(changelog, version) {
  const lines = readFileSync(resolve(ROOT, changelog), 'utf8').split('\n');
  const start = lines.findIndex(
    (l) =>
      l.startsWith('## ') &&
      (l.includes(`[${version}]`) || new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}\\b`).test(l)),
  );
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((l) => l.trim() && !l.startsWith('###'))
    .join('\n')
    .trim();
}

const problems = [];
for (const s of SURFACES) {
  const version = s.version();
  if (!version) {
    problems.push(`${s.name}: could not read its version`);
    continue;
  }
  if (!hasSection(s.changelog, version)) {
    problems.push(`${s.name} is at ${version}, but ${s.changelog} has no section for it`);
    continue;
  }
  if (!sectionBody(s.changelog, version)) {
    problems.push(`${s.name}: the ${version} section in ${s.changelog} is empty`);
    continue;
  }
  console.log(`  ok    ${s.name} ${version} is described in ${s.changelog}`);
}

if (problems.length > 0) {
  console.error('\nchangelog guard failed:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nA release users can see needs notes they can read. Add the section, then re-run.');
  process.exit(1);
}
console.log('\nEvery hand-versioned surface describes its current version.');
