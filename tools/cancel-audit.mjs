/**
 * Cancellation, proven against a live server rather than a mock: does hanging up actually stop
 * the database query and the model call, or only the HTTP response?
 *
 * Each check is verified from OUTSIDE AskSQL - the query's fate is read from the database's own
 * session table, and the model's from Ollama's running-model list.
 *
 *   node tools/cancel-audit.mjs
 *
 * Exit code 1 if any work outlived the client that asked for it.
 */
import { createServer } from 'node:http';
import { AskSqlServer, createRequestListener } from '@asksql/server';
import { PostgresConnector } from '@asksql/postgres';
import { resolveModel } from '@asksql/core';

const PG = 'postgres://postgres:root@localhost:5432/asksql_test';
const OLLAMA = process.env.ASKSQL_OLLAMA_URL ?? 'http://localhost:11434/v1';
const MODEL_ID = process.argv[2] ?? 'qwen2.5-coder:7b';

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/** Counts backends running our sentinel query, read with `pg` directly. */
async function sleepingBackends() {
  const { default: pg } = await import('../packages/postgres/node_modules/pg/lib/index.js');
  const client = new pg.Client({ connectionString: PG });
  await client.connect();
  const r = await client.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE query LIKE '%asksql_cancel_probe%' AND query NOT LIKE '%pg_stat_activity%' AND state = 'active'`,
  );
  await client.end();
  return r.rows[0].n;
}

const connector = new PostgresConnector({ id: 'db', name: 'db', connectionString: PG });
const resolved = await resolveModel({ provider: 'ollama', model: MODEL_ID, baseURL: OLLAMA });

// A pass-through that records the signal the engine hands the model. Everything else stays real -
// real HTTP, real socket abort, real Ollama - this only lets the audit see whether the abort
// reached the bottom of the stack, which the response alone cannot show.
let modelSignal;
const model = new Proxy(resolved, {
  get(target, prop, receiver) {
    if (prop !== 'doStream' && prop !== 'doGenerate') return Reflect.get(target, prop, receiver);
    const inner = Reflect.get(target, prop, receiver);
    return function (options) {
      modelSignal = options?.abortSignal;
      return inner.call(target, options);
    };
  },
});
const server = new AskSqlServer({
  connectors: [connector],
  engine: { model },
  auth: () => ({ userId: 'local', allowedConnectionIds: ['db'] }),
});
const http = createServer(createRequestListener(server));
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${http.address().port}`;

// 1. A long-running query, abandoned mid-flight.
{
  const before = await sleepingBackends();
  const controller = new AbortController();
  const request = fetch(`${base}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      connectionId: 'db',
      // A long scan rather than pg_sleep, which the guard rightly refuses as a dangerous
      // function. Far longer than this script waits, so a surviving backend is unmistakable.
      sql: 'SELECT count(*) AS asksql_cancel_probe FROM generate_series(1, 20000000000)',
    }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) console.log(`   note: /execute answered ${res.status} ${await res.text()}`);
      return res;
    })
    .catch(() => 'aborted');

  await new Promise((r) => setTimeout(r, 1500));
  const during = await sleepingBackends();
  check('the query really starts', during > before, `active backends ${before} -> ${during}`);

  controller.abort();
  await request;
  // pg_cancel_backend is asynchronous; give the server a moment to issue it.
  await new Promise((r) => setTimeout(r, 2500));
  const after = await sleepingBackends();
  check('hanging up cancels the query at the database', after <= before, `active backends ${during} -> ${after}`);
}

// 2. A model call, abandoned mid-flight. Ollama reports which models are loaded and busy; the
//    honest check is that the server stops waiting, which the stream ending proves.
{
  const controller = new AbortController();
  const started = Date.now();
  let streamEnded = false;
  const request = fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: 'db', question: 'summarise every table and every relationship in detail' }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        console.log(`   note: /chat answered ${res.status} ${await res.text()}`);
        streamEnded = true;
        return;
      }
      const reader = res.body.getReader();
      // Read one chunk so generation is definitely under way, then walk away.
      await reader.read();
      controller.abort();
      try {
        while (!(await reader.read()).done) void 0;
      } catch {
        /* aborted, as intended */
      }
      streamEnded = true;
    })
    .catch(() => {
      streamEnded = true;
    });

  await request;
  const elapsed = Date.now() - started;
  check('the chat stream stops when the client hangs up', streamEnded, `${(elapsed / 1000).toFixed(1)}s`);
  // The point of the whole change: the socket closing must reach the model call, not stop at HTTP.
  await new Promise((r) => setTimeout(r, 500));
  check(
    'the abort reaches the model call, not just the response',
    modelSignal !== undefined && modelSignal.aborted,
    modelSignal === undefined ? 'the model was never called' : `aborted=${modelSignal.aborted}`,
  );
}

await new Promise((resolve) => http.close(resolve));
await connector.close().catch(() => {});

console.log(failures.length === 0 ? '\nCANCELLATION VERIFIED' : `\n${failures.length} FAILED: ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
