/**
 * Regenerates packages/core/src/sql-keywords.ts from the databases themselves, so the reserved-word
 * lists are the engines' own rather than a hand-maintained guess that drifts.
 *
 * Needs the engines reachable; see docs for the local containers. Usage:
 *   node tools/generate-sql-keywords.mjs
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 24 });

/** Each engine's own catalog of reserved words. SQLite has none, so its published list is inlined. */
const SOURCES = {
  postgres: () =>
    sh('docker', [
      'exec',
      'asksql-pg',
      'psql',
      '-U',
      'postgres',
      '-tAc',
      "SELECT word FROM pg_get_keywords() WHERE catcode IN ('R','T') ORDER BY word",
    ]),
  mysql: () =>
    sh('docker', [
      'exec',
      'asksql-mysql',
      'mysql',
      '-uroot',
      '-N',
      '-e',
      'SELECT LOWER(WORD) FROM information_schema.KEYWORDS WHERE RESERVED=1 ORDER BY WORD',
    ]),
  oracle: () =>
    sh('docker', [
      'exec',
      'asksql-oracle',
      'bash',
      '-lc',
      `echo "SET PAGESIZE 0 FEEDBACK OFF
SELECT LOWER(keyword) FROM V\\$RESERVED_WORDS WHERE reserved='Y' ORDER BY keyword;
EXIT;" | sqlplus -s system/oracle@localhost:1521/FREEPDB1`,
    ]),
  duckdb: async () => {
    const { DuckDBInstance } = await import('../packages/duckdb/node_modules/@duckdb/node-api/lib/index.js');
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    const result = await conn.runAndReadAll(
      "SELECT keyword_name FROM duckdb_keywords() WHERE keyword_category = 'reserved' ORDER BY 1",
    );
    return result
      .getRows()
      .map((r) => String(r[0]))
      .join(',');
  },
};

const SQLITE = `abort action add after all alter always analyze and as asc attach autoincrement before begin
between by cascade case cast check collate column commit conflict constraint create cross current
current_date current_time current_timestamp database default deferrable deferred delete desc detach
distinct do drop each else end escape except exclude exclusive exists explain fail filter first
following for foreign from full generated glob group groups having if ignore immediate in index
indexed initially inner insert instead intersect into is isnull join key last left like limit match
materialized natural no not nothing notnull null nulls of offset on or order others outer over
partition plan pragma preceding primary query raise range recursive references regexp reindex release
rename replace restrict returning right rollback row rows savepoint select set table temp temporary
then ties to transaction trigger unbounded union unique update using vacuum values view virtual when
where window with without`;

const clean = (text) =>
  [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => /^[a-z_][a-z0-9_]*$/.test(w)),
    ),
  ].sort();

const engines = { sqlite: clean(SQLITE) };
for (const [name, read] of Object.entries(SOURCES)) {
  try {
    const words = clean(await read());
    if (words.length > 20) engines[name] = words;
    else console.warn(`[skip] ${name}: only ${words.length} words, is the container running?`);
  } catch (err) {
    console.warn(`[skip] ${name}: ${String(err).split('\n')[0]}`);
  }
}

// Emitting a file that quietly lost an engine would downgrade it to the union without anyone noticing.
const EXPECTED = ['postgres', 'mysql', 'oracle', 'duckdb', 'sqlite'];
const missing = EXPECTED.filter((e) => !engines[e]);
if (missing.length > 0) {
  console.error(`refusing to write: no keywords read for ${missing.join(', ')}. Start the databases and retry.`);
  process.exit(1);
}

const all = [...new Set(Object.values(engines).flat())].sort();
const index = new Map(all.map((w, i) => [w, i]));
const chunks = all.join('|').match(/.{1,110}/g) ?? [];

/** One bit per word in the shared list, so a set costs 64 characters instead of a few hundred. */
const bitmap = (words) => {
  const bytes = new Uint8Array(Math.ceil(all.length / 8));
  for (const w of words) {
    const i = index.get(w);
    bytes[i >> 3] |= 1 << (i & 7);
  }
  return Buffer.from(bytes).toString('base64');
};

const HEADER = `/**
 * Reserved words per engine, read from each database itself rather than guessed:
 * pg_get_keywords(), information_schema.KEYWORDS, V$RESERVED_WORDS, duckdb_keywords().
 * SQLite publishes a fixed list and has no catalog to query.
 *
 * Regenerate with: node tools/generate-sql-keywords.mjs
 * One word list plus a bit per engine, which costs a few hundred bytes instead of repeating words.
 */`;

writeFileSync(
  'packages/core/src/sql-keywords.ts',
  `${HEADER}

const WORDS =
${chunks.map((c, i) => `  '${c}'${i === chunks.length - 1 ? ';' : ' +'}`).join('\n')}

const WORD_LIST = WORDS.split('|');

/** One bit per word in WORD_LIST, base64 encoded. */
const BY_ENGINE: Record<string, string> = {
${Object.entries(engines)
  .map(([e, w]) => `  ${e}: '${bitmap(w)}',`)
  .join('\n')}
};

const cache = new Map<string, ReadonlySet<string>>();

/** The engine's reserved words; an unknown engine falls back to the union, which is the safe side. */
export function reservedWordsFor(engine: string): ReadonlySet<string> {
  const key = engine.toLowerCase();
  let set = cache.get(key);
  if (!set) {
    const packed = BY_ENGINE[key];
    if (packed) {
      const bytes = atob(packed);
      set = new Set(WORD_LIST.filter((_, i) => (bytes.charCodeAt(i >> 3) >> (i & 7)) & 1));
    } else set = new Set(WORD_LIST);
    cache.set(key, set);
  }
  return set;
}
`,
);

// The plugin mirrors the same data; generating both here is what stops the two from drifting.
const ktChunks = all.join('|').match(/.{1,100}/g) ?? [];
writeFileSync(
  'packages/jetbrains/src/main/kotlin/com/rahulmahadik/asksql/ide/engine/SqlKeywords.kt',
  `package com.rahulmahadik.asksql.ide.engine

/**
 * Reserved words per engine, generated alongside packages/core/src/sql-keywords.ts so the plugin and
 * the npm engine cannot drift. Regenerate both with: node tools/generate-sql-keywords.mjs
 */
object SqlKeywords {

    private val WORDS = (
${ktChunks.map((c, i) => `        "${c}"${i === ktChunks.length - 1 ? '' : ' +'}`).join('\n')}
    ).split("|")

    /** One bit per word in WORDS, base64 encoded. */
    private val BY_ENGINE = mapOf(
${Object.entries(engines)
  .map(([e, w]) => `        "${e}" to "${bitmap(w)}",`)
  .join('\n')}
    )

    private val cache = HashMap<String, Set<String>>()

    /** The engine's reserved words; an unknown engine falls back to the union, which is the safe side. */
    fun reservedWordsFor(engine: String): Set<String> {
        val key = engine.lowercase()
        cache[key]?.let { return it }
        val packed = BY_ENGINE[key]
        val set = if (packed != null) {
            val bytes = java.util.Base64.getDecoder().decode(packed)
            WORDS.filterIndexed { i, _ -> (bytes[i shr 3].toInt() shr (i and 7)) and 1 == 1 }.toSet()
        } else {
            WORDS.toSet()
        }
        cache[key] = set
        return set
    }
}
`,
);

console.log(
  'engines:',
  Object.fromEntries(Object.entries(engines).map(([e, w]) => [e, w.length])),
  'unique:',
  all.length,
);
