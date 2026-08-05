# Demo stack for the live integration tests

Thirty of the plugin's integration tests talk to a real Postgres, MySQL or MongoDB and a
real local model. Without those databases they call `assumeTrue(...)` and **skip** - the build still goes green, so it is easy to believe they ran when they did not. This directory
is what makes them run.

```bash
packages/jetbrains/tools/demo-stack/up.sh
cd packages/jetbrains && ./gradlew test -PintegrationTests=true
```

You also need [Ollama](https://ollama.com) with these models pulled:

```bash
ollama pull qwen2.5-coder:7b                # the end-to-end tests, and EdgeCaseAccuracyEvalTest
ollama pull qwen3-coder:30b-a3b-q8_0        # FailedQuestionsRetestTest, model 1 of 2
ollama pull qwen2.5-coder:32b-instruct-q8_0 # FailedQuestionsRetestTest, model 2 of 2
```

`ASKSQL_OLLAMA_MODEL` overrides those defaults (comma-separated for
`FailedQuestionsRetestTest`), so point it at whatever your machine already has.

**A missing model does not skip these tests, it fails them.** The database-backed `@Before`
probes the database socket only. The eval tests check that port 11434 answers at all, but not
that the model they want is pulled, so a running Ollama with the wrong models fails rather than
skips. That asymmetry is the single most confusing way to get a red build here, so check the
models before blaming the code.

## What is in the fixtures, and why

Nothing here is decorative. Each table exists because a specific assertion needs it, and the
scripts say which one, with file and line. The short version:

| Object | Needed by |
|---|---|
| `customers`, `orders`, `order_items` (all three engines) | The end-to-end questions, and the truth SQL in `FailedQuestionsRetestTest`, which runs **outside** the test's try/catch - a missing column throws straight out and fails the test |
| `signups` with a `'0000-00-00 00:00:00'` row (MySQL) | `MySqlEndToEndTest` - a zero DATETIME must read back as text, not a misleading NULL |
| `permissions` / `user_permissions` with `bit(8)` | The multi-bit branch of `JdbcExecutor`; `bit(1)` would take the Boolean branch and prove the opposite of what the test claims |
| `"Products"` with quoted mixed-case identifiers (Postgres) | The test that a correctly quoted identifier is not mistaken for a hallucination |
| `events` as a partitioned parent with rows in two partitions (Postgres) | The partitioned-table query test |
| Mongo `products` with one document that has **no** `price` | The heterogeneous-document test |
| Carol having zero orders (all three) | Makes the "customers who never ordered" truth query return exactly one row instead of an empty set |

Two things must be *absent*: the Mongo collection `definitely_not_a_real_collection_xyz`
(a test asserts it does not resolve), and any second user schema in the Postgres database - `CatalogPruner` switches every prompt to schema-qualified names as soon as a second schema
exists. For that reason, do **not** also load `packages/postgres/test/fixture.sql` or
`packages/mysql/test/fixture.sql` here; those belong to the npm packages' own live tests,
target different databases, and use different column names.

## Storage is ephemeral

The containers use no volumes, so `docker rm` discards the data. Re-run `up.sh` to rebuild it - the scripts are idempotent and each ends with a self-check that prints a line per
requirement, so a fixture defect surfaces at load time rather than forty minutes into an
eval run.
