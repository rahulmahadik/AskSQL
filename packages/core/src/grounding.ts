/**
 * Grounding: which identifier-shaped names in an answer are real, and whether the question asked
 * for a change at all. Shared by the SQL and MongoDB engines, and free of engine imports.
 */

import type { SchemaCatalog } from './types.js';

/** A request to add/change/remove schema objects or data: the answer is a proposal, so new names are expected. */
export const SCHEMA_CHANGE_RE =
  /\b(add|adds|adding|create|creates|creating|extend|extends|extending|alter|alters|altering|drop|drops|dropping|remove|removes|removing|delete|deletes|deleting|insert|inserts|inserting|update|updates|updating|truncate|truncates|truncating|rename|renames|renaming|migrate|migrates|migrating|introduce|introduces|introducing|modify|modifies|modifying)\b/iu;

/** SQL an answer quotes as vocabulary, not as a name it claims exists. */
/** System catalogs and monitoring views: real objects that are simply not in the user's schema. */
// `pg_` and `sqlite_` are reserved prefixes; Oracle's `user_`/`all_`/`dba_` are not, so those match by exact name.
const SYSTEM_CATALOG_RE = /^(?:pg_|sqlite_|v\$|gv\$|sys\.|mysql\.|information_schema\.|performance_schema\.)/i;

const SYSTEM_CATALOG_NAMES: ReadonlySet<string> = new Set(
  (
    'information_schema performance_schema ' +
    'user_tables user_indexes user_views user_constraints user_tab_columns user_ind_columns ' +
    'user_objects user_sequences user_triggers user_procedures user_source user_tab_statistics ' +
    'all_tables all_indexes all_views all_constraints all_tab_columns all_ind_columns all_objects ' +
    'all_sequences all_triggers all_procedures all_source ' +
    'dba_tables dba_indexes dba_views dba_constraints dba_tab_columns dba_objects dba_segments'
  ).split(' '),
);

/** True for a real system object that is not part of the user's own schema. */
function isSystemCatalog(name: string): boolean {
  if (SYSTEM_CATALOG_RE.test(name)) return true;
  const bare = name.includes('.') ? (name.split('.').pop() ?? name) : name;
  return SYSTEM_CATALOG_NAMES.has(name) || SYSTEM_CATALOG_NAMES.has(bare);
}

const SQL_VOCABULARY: ReadonlySet<string> = new Set(
  // One string rather than a quoted array: markedly smaller once gzipped for the browser.
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

// Column types and constraint words that read like identifiers but never name a table or column.
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
 * Identifier-shaped names in a prose answer that are absent from the catalog - the grounding floor
 * for explainSchema. Only snake_case tokens and backtick/double-quote-wrapped names are inspected.
 */
/** Names the answer DEFINES with `AS`: output labels, not claims that something exists. SQL context only. */
const ALIAS_RE = /\bas\s+(?:`([^`]+)`|"([^"]+)"|([a-z_][\w$]*))/giu;
const PROSE_AS_RE = /\b(such|known|same|referred to|serves|acts|described)\s+$/iu;
// `with` must look like an actual CTE, not the English preposition.
const SQL_CONTEXT_RE = /\bselect\b|\bwith\s+(?:recursive\s+)?["`\w]+\s+as\s*\(/iu;

/** The statement the alias sits in: back to the previous fence, blank line or `;`. */
function statementBefore(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('```', index), text.lastIndexOf('\n\n', index), text.lastIndexOf(';', index));
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

/** Column names that are ordinary English first and never count on their own as schema talk. */
const EVERYDAY_NAMES: ReadonlySet<string> = new Set([
  'name',
  'date',
  'time',
  'type',
  'value',
  'status',
  'code',
  'text',
  'title',
  'number',
  'size',
  'level',
  'state',
  'key',
  'data',
  'user',
  'group',
  'count',
  'total',
  'amount',
  'active',
  'description',
  'comment',
  'label',
  'link',
  'file',
  'path',
  'note',
  'notes',
]);

/** True when the text names a table, view or column that really exists - i.e. it is an answer about this database. */
export function mentionsCatalogName(text: string, catalog: SchemaCatalog): boolean {
  const lower = text.toLowerCase();
  // Whole-word matching; a qualified reference counts as its parts too, so `shop.orders` finds `orders`.
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

/** MongoDB vocabulary that reads like an identifier but never names a collection or field. */
const MONGO_NON_IDENTIFIER: ReadonlySet<string> = new Set([
  'from',
  'localfield',
  'foreignfield',
  'as',
  'pipeline',
  'let',
  'into',
  'on',
  'cond',
  'input',
  'path',
  'output',
  'unit',
  'startdate',
  'enddate',
  'whenmatched',
  'whennotmatched',
  'depthfield',
  'preservenullandemptyarrays',
  'includearrayindex',
  'connectfromfield',
  'connecttofield',
  'maxdepth',
  'aggregate',
  'find',
  'sort',
  'limit',
  'skip',
  'count',
  'distinct',
  'collection',
  'document',
]);

export interface GroundingOptions {
  /**
   * MongoDB prose: `$lookup` and friends are operators, not collections, and a double-quoted
   * token is a VALUE, not a quoted identifier as it would be in SQL.
   */
  readonly documentStyle?: boolean;
}

/** An identifier, optionally schema-qualified. Placeholders, literals and operators do not match. */
const IDENTIFIER_SHAPE = /^[a-z_][a-z0-9_$-]*(?:\.[a-z_][a-z0-9_$-]*)*$/i;

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
  // Document style: a fenced block is a pipeline, so its spec keys and aliases are syntax, not claims.
  const scanned = opts.documentStyle ? answer.replace(/```[\s\S]*?```/g, ' ') : answer;
  const re = /`([^`\s]+)`|"([\w.]+)"|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scanned)) !== null) {
    if (opts.documentStyle && m[2]) continue; // "shipped" is a value, not an identifier
    // Backticks wrap anything, so a placeholder or a literal can arrive here.
    if (m[1] !== undefined && !IDENTIFIER_SHAPE.test(m[1])) continue;
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase();
    if (raw.startsWith('$')) continue; // $lookup / $group are operators
    // Backticked SQL vocabulary is not a name claim; a call with parentheses is a function.
    if (raw.includes('(') || SQL_VOCABULARY.has(raw)) continue;
    if (!raw || NON_IDENTIFIER_SNAKE.has(raw)) continue;
    if (opts.documentStyle && MONGO_NON_IDENTIFIER.has(raw)) continue;
    // `as: "customer_info"` names the join's OUTPUT, the document counterpart of a SQL alias.
    if (opts.documentStyle && /\bas\b\s*:?\s*["'`]?$/i.test(scanned.slice(Math.max(0, m.index - 12), m.index)))
      continue;
    const bare = raw.includes('.') ? (raw.split('.').pop() ?? raw) : raw;
    if (known.has(raw) || known.has(bare)) continue;
    // A system catalog is a real object, just not one of the user's own.
    if (isSystemCatalog(raw)) continue;
    found.add(raw);
  }
  return [...found];
}
