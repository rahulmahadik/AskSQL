/**
 * Grounding: which identifier-shaped names in an answer are real, and whether the question
 * asked for a change at all. Shared by the SQL and MongoDB engines, and free of engine
 * imports so the MongoDB path does not pull SQL parsing into browser bundles.
 */

import type { SchemaCatalog } from './types.js';

/**
 * A request to add/change/remove schema objects OR data: the answer is a proposal, so its new
 * names are expected. Third-person forms included ("a command that deletes"), past tenses not -
 * "orders created last week" is a question about data.
 */
export const SCHEMA_CHANGE_RE =
  /\b(add|adds|adding|create|creates|creating|extend|extends|extending|alter|alters|altering|drop|drops|dropping|remove|removes|removing|delete|deletes|deleting|insert|inserts|inserting|update|updates|updating|truncate|truncates|truncating|rename|renames|renaming|migrate|migrates|migrating|introduce|introduces|introducing|modify|modifies|modifying)\b/iu;

/**
 * SQL an answer quotes as vocabulary, not as a name it claims exists. The snake_case entries
 * matter most - those are picked up from prose with no backticks. Never list a plausible real
 * column name (`created_at`, `user_id`).
 */
const SQL_VOCABULARY: ReadonlySet<string> = new Set(
  // One string rather than a quoted array: identical set, markedly smaller once gzipped,
  // which matters because this ships to the browser.
  (
    'select from where join inner outer left right full cross on group order having limit offset fetch ' +
    'next rows row only ties union intersect except all distinct as and or not null nulls is in exists ' +
    'any some between like ilike similar escape case when then else end with recursive lateral natural ' +
    'using over partition window filter within asc desc collate order_by group_by is_null left_join ' +
    'inner_join outer_join cross_join insert update delete merge set values into returning explain create ' +
    'alter drop truncate rename add modify grant revoke begin commit rollback savepoint analyze vacuum ' +
    'table view materialized schema database column trigger function procedure sequence restrict ' +
    'on_delete on_update on_conflict count sum avg min max stddev variance array_agg string_agg json_agg ' +
    'jsonb_agg group_concat listagg row_number rank dense_rank percent_rank ntile lag lead first_value ' +
    'last_value nth_value cume_dist coalesce nullif ifnull isnull nvl decode iif greatest least cast ' +
    'convert extract substring substr trim ltrim rtrim upper lower initcap length char_length ' +
    'octet_length replace concat concat_ws position round floor ceil ceiling abs mod power sqrt random ' +
    'unnest generate_series json_extract json_build_object jsonb_build_object now date interval epoch age ' +
    'date_trunc date_part datediff dateadd to_char to_date to_number to_timestamp current_date ' +
    'current_time current_timestamp current_user localtime localtimestamp sysdate index constraint unique ' +
    'default check identity generated stored'
  ).split(' '),
);

// Column types and constraint words that read like identifiers but never name a table or column,
// so a DDL suggestion's `integer`/`unique` isn't mistaken for a proposed object.
const NON_IDENTIFIER_SNAKE: ReadonlySet<string> = new Set([
  'primary_key',
  'foreign_key',
  'foreign_keys',
  'data_type',
  'data_types',
  'not_null',
  'auto_increment',
  'use_case',
  'read_only',
  'read_write',
  'integer',
  'int',
  'bigint',
  'smallint',
  'serial',
  'bigserial',
  'varchar',
  'char',
  'text',
  'boolean',
  'bool',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'numeric',
  'decimal',
  'real',
  'uuid',
  'json',
  'jsonb',
  'unique',
  'primary',
  'foreign',
  'constraint',
  'references',
  'index',
  'default',
  'cascade',
  'null',
  'column',
  'table',
]);

/**
 * Identifier-shaped names in a prose answer that are absent from the catalog - the
 * grounding floor for explainSchema. Conservative by design: only snake_case tokens and
 * backtick/double-quote-wrapped names are inspected, so ordinary English never trips it
 * while an invented `customer_history` is caught. Real schema names pass (they're in the
 * catalog); a small stopword set covers SQL vocabulary like `foreign_key`.
 */
/**
 * Names the answer DEFINES with `AS`, which are output labels rather than claims that
 * something exists in the schema - flagging them made every aggregate look ungrounded.
 *
 * Only aliases in SQL context count. English "such as customer_history" is exactly the
 * hallucination this floor exists to catch, so an `as` with no SELECT near it is not an alias.
 */
const ALIAS_RE = /\bas\s+(?:`([^`]+)`|"([^"]+)"|([a-z_][\w$]*))/giu;
const PROSE_AS_RE = /\b(such|known|same|referred to|serves|acts|described)\s+$/iu;
// `with` must look like an actual CTE, not the English preposition: "Along with shop.orders,
// activity is stored as customer_history" was being read as SQL, which whitelisted
// `customer_history` and silently disarmed the floor for exactly the invention it exists to catch.
const SQL_CONTEXT_RE = /\bselect\b|\bwith\s+(?:recursive\s+)?["`\w]+\s+as\s*\(/iu;

/**
 * The statement the alias sits in: back to the previous fence, blank line or `;`. A fixed
 * character window silently dropped the later aliases of an ordinary multi-column aggregate,
 * which then looked like invented names and triggered a pointless repair round-trip.
 */
function statementBefore(text: string, index: number): string {
  const start = Math.max(
    text.lastIndexOf('```', index),
    text.lastIndexOf('\n\n', index),
    text.lastIndexOf(';', index),
  );
  return text.slice(start + 1, index);
}

/** A CTE the answer defines itself: its own name, like a column alias, is not an invention. */
const CTE_DEF_RE = /\b([a-z_][\w$]*)\s+as\s*\(/giu;

function definedAliases(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(ALIAS_RE)) {
    const before = statementBefore(answer, m.index);
    if (PROSE_AS_RE.test(before)) continue;
    if (!SQL_CONTEXT_RE.test(before)) continue;
    out.push((m[1] ?? m[2] ?? m[3] ?? '').toLowerCase());
  }
  for (const m of answer.matchAll(CTE_DEF_RE)) out.push(m[1]!.toLowerCase());
  return out;
}

/**
 * Column names that are ordinary English first. Matching these made "my name is ..." count as
 * schema talk and switched off the off-topic backstop. Short on purpose: a wrong decline is worse.
 */
const EVERYDAY_NAMES: ReadonlySet<string> = new Set([
  'name', 'date', 'time', 'type', 'value', 'status', 'code', 'text', 'title', 'number',
  'size', 'level', 'state', 'key', 'data', 'user', 'group', 'count', 'total', 'amount',
  'active', 'description', 'comment', 'label', 'link', 'file', 'path', 'note', 'notes',
]);

/** True when the text names a table, view or column that really exists - i.e. it is an answer about this database. */
export function mentionsCatalogName(text: string, catalog: SchemaCatalog): boolean {
  const lower = text.toLowerCase();
  // Whole-word matching: a bare `includes` also fired on "rename"/"namespace" containing "name".
  // Qualified references count as their parts too, so `shop.orders` still finds table `orders`.
  const present = new Set<string>();
  for (const token of lower.match(/[a-z_][a-z0-9_$.]*/g) ?? []) {
    present.add(token);
    for (const segment of token.split('.')) if (segment) present.add(segment);
  }
  const counts = (name: string): boolean => {
    const n = name.toLowerCase();
    if (n.length <= 2) return false;
    // A name with an underscore or a schema qualifier is never accidental English.
    if (!n.includes('_') && EVERYDAY_NAMES.has(n)) return false;
    return present.has(n);
  };
  for (const t of catalog.tables) {
    if (counts(t.name)) return true;
    for (const c of t.columns) if (counts(c.name)) return true;
  }
  return false;
}

/**
 * MongoDB vocabulary that reads like an identifier but never names a collection or field:
 * `$lookup` spec keys and stage options. Without these, "use `from`, `localField` and `as`"
 * - a correct description of a join - was reported as three invented names.
 */
const MONGO_NON_IDENTIFIER: ReadonlySet<string> = new Set([
  'from', 'localfield', 'foreignfield', 'as', 'pipeline', 'let', 'into', 'on', 'cond', 'input',
  'path', 'output', 'unit', 'startdate', 'enddate', 'whenmatched', 'whennotmatched', 'depthfield',
  'preservenullandemptyarrays', 'includearrayindex', 'connectfromfield', 'connecttofield', 'maxdepth',
  'aggregate', 'find', 'sort', 'limit', 'skip', 'count', 'distinct', 'collection', 'document',
]);

export interface GroundingOptions {
  /**
   * MongoDB prose. Two shapes mean something different there: `$lookup` and friends are
   * operators, not collections, and a double-quoted token is a VALUE ("shipped"), not a
   * quoted identifier as it would be in SQL. Reporting either as invented made every correct
   * MongoDB answer come back ungrounded.
   */
  readonly documentStyle?: boolean;
}

export function unknownReferencesInProse(
  answer: string,
  catalog: SchemaCatalog,
  opts: GroundingOptions = {},
): string[] {
  const known = new Set<string>();
  for (const s of catalog.schemas) known.add(s.toLowerCase());
  for (const t of catalog.tables) {
    known.add(t.name.toLowerCase());
    if (t.schema) {
      known.add(t.schema.toLowerCase());
      known.add(`${t.schema.toLowerCase()}.${t.name.toLowerCase()}`);
    }
    for (const c of t.columns) known.add(c.name.toLowerCase());
  }
  for (const alias of definedAliases(answer)) known.add(alias);
  const found = new Set<string>();
  // Document style: a fenced block is a pipeline, and its `$lookup` spec keys (from, localField,
  // foreignField, as) and output aliases are syntax, not claims that a collection exists. SQL keeps
  // its fenced blocks in scope, where `FROM shop.ghost_table` IS such a claim.
  const scanned = opts.documentStyle ? answer.replace(/```[\s\S]*?```/g, ' ') : answer;
  const re = /`([^`\s]+)`|"([\w.]+)"|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scanned)) !== null) {
    if (opts.documentStyle && m[2]) continue; // "shipped" is a value, not an identifier
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase();
    if (raw.startsWith('$')) continue; // $lookup / $group are operators
    // Backticked SQL vocabulary is not a name claim; a call with parentheses is a function.
    if (raw.includes('(') || SQL_VOCABULARY.has(raw)) continue;
    if (!raw || NON_IDENTIFIER_SNAKE.has(raw)) continue;
    if (opts.documentStyle && MONGO_NON_IDENTIFIER.has(raw)) continue;
    // `as: "customer_info"` names the join's OUTPUT, the document counterpart of a SQL alias.
    if (opts.documentStyle && /\bas\b\s*:?\s*["'`]?$/i.test(scanned.slice(Math.max(0, m.index - 12), m.index))) continue;
    const bare = raw.includes('.') ? (raw.split('.').pop() ?? raw) : raw;
    if (known.has(raw) || known.has(bare)) continue;
    found.add(raw);
  }
  return [...found];
}
