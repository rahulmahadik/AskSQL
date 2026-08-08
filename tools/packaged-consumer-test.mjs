/**
 * Installs the packed tarballs into a throwaway project outside the workspace and exercises every
 * declared export there.
 *
 * The monorepo's own tests import from source through pnpm's workspace links, so a dependency that
 * is used but never declared still resolves. A consumer gets no such help. Installing nested (no
 * hoisting) reproduces what they see: an import that is not a declared dependency or peer fails.
 *
 *   node tools/packaged-consumer-test.mjs [--skip-build] [--keep]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP_BUILD = process.argv.includes('--skip-build');
const KEEP = process.argv.includes('--keep');

/** Peers we install, so those packages can be imported and run for real rather than probed. */
const INSTALLED_PEERS = [
  'better-sqlite3@^12.2.0',
  'react@^19.1.1',
  'react-dom@^19.1.1',
  '@ai-sdk/openai-compatible@^3.0.9',
  '@modelcontextprotocol/sdk@^1.18.0',
];
/** Peers too heavy or too native to install for a packaging check; import is probed instead. */
const PROBE_ONLY = new Set([
  '@asksql/oracle',
  '@asksql/mysql',
  '@asksql/postgres',
  '@asksql/mongodb',
  '@asksql/duckdb',
]);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function publishablePackages() {
  const out = [];
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const file = join(ROOT, 'packages', dir, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (pkg.private || !pkg.name?.startsWith('@asksql/')) continue;
    const exports = typeof pkg.exports === 'object' ? Object.keys(pkg.exports) : ['.'];
    out.push({
      name: pkg.name,
      dir: join(ROOT, 'packages', dir),
      exports,
      peers: Object.keys(pkg.peerDependencies ?? {}),
    });
  }
  return out;
}

const packages = publishablePackages();
console.log(`${packages.length} publishable packages`);

if (!SKIP_BUILD) {
  console.log('building...');
  run('pnpm', ['-r', '--filter', './packages/**', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

const staging = mkdtempSync(join(tmpdir(), 'asksql-tarballs-'));
const tarballs = [];
for (const pkg of packages) {
  const out = run('pnpm', ['pack', '--pack-destination', staging], { cwd: pkg.dir }).trim();
  const file = out.split('\n').filter(Boolean).pop();
  tarballs.push(file);
  console.log(`  packed ${pkg.name}`);
}

const consumer = mkdtempSync(join(tmpdir(), 'asksql-consumer-'));
mkdirSync(join(consumer, 'src'), { recursive: true });
writeFileSync(
  join(consumer, 'package.json'),
  `${JSON.stringify({ name: 'asksql-consumer', version: '1.0.0', type: 'module', private: true }, null, 2)}\n`,
);

console.log(`installing into ${consumer} (nested, no hoisting)`);
// --legacy-peer-deps stops npm auto-installing peers, so an undeclared third-party import has
// nothing to resolve against. @asksql imports are exempt: every @asksql tarball is installed at
// the consumer root. tests/peer-install-conflict.test.ts covers the core peer instead.
run(
  'npm',
  [
    'install',
    '--install-strategy=nested',
    '--legacy-peer-deps',
    '--no-audit',
    '--no-fund',
    ...tarballs,
    ...INSTALLED_PEERS,
  ],
  {
    cwd: consumer,
    stdio: 'inherit',
    timeout: 600_000,
  },
);

const failures = [];
const pass = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg, detail) => {
  console.log(`  FAIL  ${msg}`);
  if (detail) console.log(`        ${String(detail).split('\n')[0]}`);
  failures.push(msg);
};

/** Import a specifier in the consumer and report what, if anything, failed to resolve. */
function probeImport(specifier) {
  try {
    run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)})`], {
      cwd: consumer,
      timeout: 120_000,
    });
    return { ok: true };
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const missing = text.match(/Cannot find (?:package|module) '([^']+)'/)?.[1];
    return { ok: false, missing, text };
  }
}

console.log('\nexport resolution');
for (const pkg of packages) {
  for (const sub of pkg.exports) {
    const specifier = sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
    const result = probeImport(specifier);
    if (result.ok) {
      pass(specifier);
    } else if (result.missing && pkg.peers.includes(result.missing)) {
      pass(`${specifier} (needs peer ${result.missing}, declared)`);
    } else if (result.missing && PROBE_ONLY.has(pkg.name) && !result.missing.startsWith('@asksql/')) {
      pass(`${specifier} (needs ${result.missing}, not installed here)`);
    } else if (result.missing) {
      fail(`${specifier} imports '${result.missing}' but does not declare it`, result.text);
    } else {
      fail(`${specifier} failed to load`, result.text);
    }
  }
}

writeFileSync(
  join(consumer, 'src', 'exercise.mjs'),
  `
import {
  guardSql, resolveGuardPolicy, DEFAULT_GUARD_POLICY, POSTGRES_DIALECT, SQLITE_DIALECT, ORACLE_DIALECT,
  formatCatalogForPrompt, pruneCatalog, estimateTokens, extractSql, createAskSql, resolveModel,
  isWriteRequest, isMetadataQuestion, isSchemaAdviceQuestion, isCapabilityQuestion, MemoryHistoryStore,
} from '@asksql/core';
import { SqliteConnector } from '@asksql/sqlite';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const awaitChecks = [];

const policy = resolveGuardPolicy(DEFAULT_GUARD_POLICY);

check('guard allows a SELECT', () => {
  const r = guardSql({ sql: 'SELECT id FROM t', dialect: POSTGRES_DIALECT, policy });
  assert(r.allowed, 'expected allowed');
  return r.sql;
});
check('guard refuses a DELETE', () => {
  const r = guardSql({ sql: 'DELETE FROM t', dialect: POSTGRES_DIALECT, policy });
  assert(!r.allowed, 'expected refusal');
  return r.reason;
});
check('guard refuses stacked statements', () => {
  const r = guardSql({ sql: 'SELECT 1; DROP TABLE t', dialect: POSTGRES_DIALECT, policy });
  assert(!r.allowed, 'expected refusal');
  return r.reason;
});
check('guard refuses LIMIT on Oracle', () => {
  const r = guardSql({ sql: 'SELECT id FROM t LIMIT 10', dialect: ORACLE_DIALECT, policy });
  assert(!r.allowed, 'expected refusal');
  return r.reason;
});
check('routing predicates', () => {
  assert(isWriteRequest('delete all cancelled orders'), 'write not detected');
  assert(!isWriteRequest('can you delete my data'), 'capability misread as write');
  assert(isCapabilityQuestion('can you delete my data'), 'capability not detected');
  assert(isMetadataQuestion('show me the tables'), 'listing not detected');
  assert(isSchemaAdviceQuestion('why is my query on orders so slow'), 'advice not detected');
  return 'all five';
});
check('extractSql unwraps a fenced block', () => {
  const fence = '\\u0060\\u0060\\u0060';
  const out = extractSql(\`Here you go:\n\n\${fence}sql\nSELECT 1\n\${fence}\`);
  assert(out.sql === 'SELECT 1', \`got \${JSON.stringify(out)}\`);
  return \`\${out.sql} (source: \${out.source})\`;
});
awaitChecks.push(['resolveModel rejects an unknown provider', async () => {
  try {
    await resolveModel({ provider: 'nope', model: 'x' });
  } catch (error) {
    return error.message;
  }
  throw new Error('expected a rejection');
}]);
awaitChecks.push(['resolveModel rejects an empty model name', async () => {
  try {
    await resolveModel({ provider: 'openai', model: '  ', apiKey: 'k' });
  } catch (error) {
    return error.message;
  }
  throw new Error('expected a rejection');
}]);
awaitChecks.push(['resolveModel requires a key for a cloud provider', async () => {
  try {
    await resolveModel({ provider: 'openai', model: 'gpt-4o' });
  } catch (error) {
    return error.message;
  }
  throw new Error('expected a rejection');
}]);
check('MemoryHistoryStore round-trips', () => {
  const store = new MemoryHistoryStore();
  return typeof store.load === 'function' ? 'has load' : 'no load';
});

const dbPath = join(mkdtempSync(join(tmpdir(), 'asksql-consumer-db-')), 'shop.db');
const seed = new Database(dbPath);
seed.exec(\`
  CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, region TEXT);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total_cents INTEGER);
  INSERT INTO customers VALUES (1,'a@example.com','EU'),(2,'b@example.com','US');
  INSERT INTO orders VALUES (1,1,2500),(2,1,1000),(3,2,700);
\`);
seed.close();

const connector = new SqliteConnector({ id: 'shop', name: 'Shop', file: dbPath });
await connector.connect();
const catalog = await connector.introspect();

check('connector introspects a real database', () => {
  const names = catalog.tables.map((t) => t.name).sort();
  assert(names.includes('customers') && names.includes('orders'), \`got \${names.join()}\`);
  return names.join(', ');
});
check('the foreign key survives introspection', () => {
  const orders = catalog.tables.find((t) => t.name === 'orders');
  const fks = orders.foreignKeys ?? [];
  assert(fks.length > 0, 'no foreign key introspected');
  return \`orders -> \${fks[0].refTable ?? fks[0].referencedTable ?? '?'}\`;
});
check('catalog formats for the prompt', () => {
  const text = formatCatalogForPrompt(catalog);
  assert(text.includes('customers') && text.includes('orders'), 'tables missing from prompt text');
  assert(estimateTokens(text) > 0, 'token estimate was zero');
  return \`\${text.length} chars, ~\${estimateTokens(text)} tokens\`;
});
check('pruneCatalog keeps the asked-about table', () => {
  const pruned = pruneCatalog(catalog, 'how much did each customer spend');
  assert(pruned.catalog.tables.length > 0, 'pruned everything away');
  return \`\${pruned.catalog.tables.length} tables kept\`;
});

const result = await connector.execute(
  'SELECT c.email, SUM(o.total_cents) AS cents FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.email ORDER BY cents DESC',
);
check('connector runs a real query and returns real numbers', () => {
  assert(result.rowCount === 2, \`expected 2 rows, got \${result.rowCount}\`);
  assert(Number(result.rows[0][1]) === 3500, \`expected 3500, got \${result.rows[0][1]}\`);
  return \`\${result.rowCount} rows, top = \${result.rows[0][0]} \${result.rows[0][1]}\`;
});

awaitChecks.push(['the packaged connector opens the file read-only', async () => {
  const pragma = await connector.execute('PRAGMA query_only');
  const queryOnly = Number(pragma.rows[0][0]);
  let direct = 'no error';
  try {
    new Database(dbPath, { readonly: true }).exec('DELETE FROM orders');
  } catch (error) {
    direct = error.code ?? error.message.slice(0, 40);
  }
  assert(queryOnly === 1 || direct.includes('READONLY'), \`query_only=\${queryOnly}, direct write: \${direct}\`);
  return \`query_only=\${queryOnly}, direct write rejected with \${direct}\`;
}]);

let wrote = 'no error';
try {
  await connector.execute('DELETE FROM orders');
} catch (error) {
  wrote = error.message.slice(0, 70);
}
const after = await connector.execute('SELECT COUNT(*) FROM orders');
check('the packaged connector refuses a write against a real file', () => {
  assert(wrote !== 'no error', 'the packaged connector executed a DELETE without error');
  assert(Number(after.rows[0][0]) === 3, \`rows changed: \${after.rows[0][0]}\`);
  return wrote;
});

check('createAskSql builds an engine from the packaged pieces', () => {
  const engine = createAskSql({
    connectors: [connector],
    model: { provider: 'openai-compatible', model: 'stub', baseURL: 'http://127.0.0.1:1/v1' },
  });
  assert(typeof engine.ask === 'function', 'no ask()');
  return Object.keys(engine).sort().join(', ');
});

for (const [name, fn] of awaitChecks) {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

await connector.close();
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
`,
);

console.log('\nruntime behaviour through the installed packages');
let exercise;
try {
  exercise = run(process.execPath, ['src/exercise.mjs'], { cwd: consumer, timeout: 300_000 });
} catch (error) {
  exercise = `${error.stdout ?? ''}`;
  if (!exercise.trim()) fail('the consumer exercise crashed', `${error.stderr ?? error.message}`);
}
const parsed = (() => {
  const start = exercise.indexOf('[');
  try {
    return JSON.parse(exercise.slice(start));
  } catch {
    return null;
  }
})();
if (parsed) {
  for (const r of parsed) (r.ok ? pass : fail)(`${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
} else if (exercise.trim()) {
  fail('could not parse the consumer exercise output', exercise);
}

console.log('\nreact and widget load in a DOM-free process');
for (const spec of ['@asksql/react', '@asksql/widget']) {
  const result = probeImport(spec);
  (result.ok ? pass : fail)(`${spec} imports without a browser`, result.text);
}

if (!KEEP) {
  rmSync(staging, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
} else {
  console.log(`\nkept ${consumer}`);
}

console.log(`\n${failures.length === 0 ? 'PACKAGED CONSUMER TEST PASSED' : `${failures.length} FAILURE(S)`}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
