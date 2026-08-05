/**
 * SchemaCatalog utilities: prompt formatting, deterministic pruning
 * (name/term match + FK-closure expansion, tier 1) and the join
 * graph derived from foreign keys - the #1 accuracy lever.
 */

import type { PrunerSettings, SchemaCatalog, TableInfo } from './types.js';
import { VALUE_SAMPLE_MAX_DISTINCT } from './types.js';
import { dialectFor } from './dialects.js';

/** Cheap token estimate (~4 chars per token) for budget decisions only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const COMMENT_CAP = 200;
/** FK-closure BFS depth: a 2-hop chain (A-B-C) survives from one matched seed. */
const FK_CLOSURE_HOPS = 2;
/** Max length of a single rendered sample/enum value. */
const VALUE_SAMPLE_CAP = 80;

/** A sampled/enum value rendered into the schema: `|` is replaced, whitespace flattened, length capped. */
function sanitizeValue(v: string): string {
  const flat = v.replace(/\s+/gu, ' ').trim().replace(/\|/gu, '/');
  return flat.length > VALUE_SAMPLE_CAP ? flat.slice(0, VALUE_SAMPLE_CAP) : flat;
}

function sanitizeComment(comment: string | null | undefined): string | null {
  if (!comment) return null;
  const flat = comment.replace(/\s+/gu, ' ').trim();
  if (!flat) return null;
  return flat.length > COMMENT_CAP ? `${flat.slice(0, COMMENT_CAP)}...` : flat;
}

/** A name that can be written without quotes; anything else is rendered quoted. */
const PLAIN_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Words an engine will not accept as a bare identifier; not exhaustive across every dialect. */
const RESERVED_WORDS: ReadonlySet<string> = new Set(
  (
    'select from where group by order having limit offset union all distinct join inner outer left ' +
    'right full cross natural on using as into insert update delete set values create drop alter ' +
    'table column view index key primary foreign unique constraint references default check null ' +
    'not and or in is like between case when then else end exists any some cast collate with ' +
    'recursive returning window over partition range rows current session system user grant revoke ' +
    'to begin commit rollback transaction lock database schema trigger procedure function ' +
    'desc asc date time timestamp interval level size type comment position language'
  ).split(' '),
);

/**
 * True when the engine would not read the bare name back as itself; an unquoted identifier folds
 * case - PostgreSQL to lower, Oracle to upper.
 */
function needsQuoting(name: string, engine: string): boolean {
  if (!PLAIN_IDENTIFIER_RE.test(name)) return true;
  if (RESERVED_WORDS.has(name.toLowerCase())) return true;
  if (engine === 'oracle') return name !== name.toUpperCase();
  // MySQL, SQLite and DuckDB match identifiers case-insensitively, so folding cannot lose a name.
  if (engine === 'mysql' || engine === 'sqlite' || engine === 'duckdb') return false;
  return name !== name.toLowerCase();
}

function promptIdentifier(name: string, quote: string, engine: string): string {
  if (!needsQuoting(name, engine)) return name;
  // Doubling is how every supported engine escapes its own quote character inside an identifier.
  return `${quote}${name.split(quote).join(quote + quote)}${quote}`;
}

function qualifiedName(t: TableInfo, multiSchema: boolean, quote: string, engine: string): string {
  const name = promptIdentifier(t.name, quote, engine);
  return multiSchema && t.schema ? `${promptIdentifier(t.schema, quote, engine)}.${name}` : name;
}

/** Render a catalog as compact prompt text; the prompt wraps the whole block as untrusted data. */
/** Bounds so a large catalog cannot crowd out the tables themselves. */
const MAX_INDEXES_PER_TABLE = 8;
const MAX_OBJECTS = 30;

export function formatCatalogForPrompt(catalog: SchemaCatalog): string {
  const multiSchema = catalog.schemas.length > 1;
  const quote = dialectFor(catalog.engine)?.quoteChar ?? '"';
  const engine = catalog.engine;
  const lines: string[] = [];

  for (const t of catalog.tables) {
    if (t.partitionOf) continue; // collapsed to parent
    const head = t.kind === 'view' ? 'VIEW' : t.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'TABLE';
    const comment = sanitizeComment(t.comment);
    const est = typeof t.rowEstimate === 'number' && t.rowEstimate >= 0 ? ` [~${Math.round(t.rowEstimate)} rows]` : '';
    lines.push(
      `${head} ${qualifiedName(t, multiSchema, quote, engine)}${est}${comment ? ` -- ${comment}` : ''}${
        t.source === 'file' ? ' [from uploaded file]' : ''
      }`,
    );
    for (const c of t.columns) {
      const bits: string[] = [` ${promptIdentifier(c.name, quote, engine)} ${c.dbType}`];
      if (t.primaryKey.includes(c.name)) bits.push('PK');
      const fk = t.foreignKeys.find((f) => f.columns.includes(c.name));
      if (fk)
        bits.push(
          `FK->${fk.refSchema ? `${promptIdentifier(fk.refSchema, quote, engine)}.` : ''}${promptIdentifier(
            fk.refTable,
            quote,
            engine,
          )}.${fk.refColumns.map((c) => promptIdentifier(c, quote, engine)).join(',')}`,
        );
      if (!c.nullable) bits.push('NOT NULL');
      if (c.enumValues && c.enumValues.length > 0) {
        bits.push(`values: ${c.enumValues.slice(0, VALUE_SAMPLE_MAX_DISTINCT).map(sanitizeValue).join('|')}`);
      } else if (c.sampledValues && c.sampledValues.length > 0) {
        // Observed values, not a declared enum: labelled as the known-so-far set.
        bits.push(`sample values: ${c.sampledValues.slice(0, VALUE_SAMPLE_MAX_DISTINCT).map(sanitizeValue).join('|')}`);
      }
      const colComment = sanitizeComment(c.comment);
      if (colComment) bits.push(`-- ${colComment}`);
      lines.push(bits.join(' '));
    }
    // Existing indexes are shown so index questions can be answered.
    if (t.indexes.length > 0) {
      const shown = t.indexes
        .slice(0, MAX_INDEXES_PER_TABLE)
        .map(
          (i) =>
            `${i.name}(${i.columns.map((c) => promptIdentifier(c, quote, engine)).join(',')})${
              i.unique ? ' UNIQUE' : ''
            }${i.predicate ? ' WHERE ...' : ''}`,
        );
      lines.push(` INDEXES: ${shown.join(', ')}`);
    }
  }

  if (catalog.triggers.length > 0) {
    lines.push('TRIGGERS:');
    for (const tr of catalog.triggers.slice(0, MAX_OBJECTS)) {
      const on = tr.schema ? `${tr.schema}.${tr.table}` : tr.table;
      lines.push(` ${tr.name} ${tr.timing} ${tr.events.join('/')} ON ${on}${tr.enabled ? '' : ' [disabled]'}`);
    }
  }

  const procedures = catalog.routines.filter((r) => r.kind === 'procedure');
  if (procedures.length > 0) {
    // Listed so "what procedures exist" can be answered; never offered as something to call.
    lines.push('STORED PROCEDURES (reference only - NEVER call these; a read-only query cannot invoke them):');
    for (const r of procedures.slice(0, MAX_OBJECTS)) {
      lines.push(` ${multiSchema && r.schema ? `${r.schema}.${r.name}` : r.name}(${r.args})`);
    }
  }

  if (catalog.sequences.length > 0) {
    const names = catalog.sequences
      .slice(0, MAX_OBJECTS)
      .map((q) => (multiSchema && q.schema ? `${q.schema}.${q.name}` : q.name));
    lines.push(`SEQUENCES: ${names.join(', ')}`);
  }

  if (catalog.enums.length > 0) {
    lines.push('ENUM TYPES:');
    for (const e of catalog.enums) {
      lines.push(` ${e.name}: ${e.values.slice(0, 32).map(sanitizeValue).join('|')}`);
    }
  }

  const callable = catalog.routines.filter(
    (r) => r.kind === 'function' && (r.volatility === 'immutable' || r.volatility === 'stable'),
  );
  if (callable.length > 0) {
    lines.push('CALLABLE READ-ONLY FUNCTIONS (safe to use in SELECT; call by the exact name shown):');
    for (const r of callable.slice(0, 40)) {
      const fnName = multiSchema && r.schema ? `${r.schema}.${r.name}` : r.name;
      lines.push(` ${fnName}(${r.args})${r.returns ? ` -> ${r.returns}` : ''}`);
    }
  }

  const edges = joinGraph(catalog);
  if (edges.length > 0) {
    lines.push('RELATIONSHIPS (join paths):');
    for (const e of edges.slice(0, 200)) lines.push(` ${e}`);
  }

  return lines.join('\n');
}

/** FK edges as readable join hints. */
export function joinGraph(catalog: SchemaCatalog): string[] {
  const multiSchema = catalog.schemas.length > 1;
  const quote = dialectFor(catalog.engine)?.quoteChar ?? '"';
  const engine = catalog.engine;
  const edges: string[] = [];
  const declared = new Set<string>();
  for (const t of catalog.tables) {
    for (const fk of t.foreignKeys) {
      edges.push(
        `${qualifiedName(t, multiSchema, quote, engine)}.${fk.columns
          .map((c) => promptIdentifier(c, quote, engine))
          .join(
            ',',
          )} = ${fk.refSchema && multiSchema ? `${promptIdentifier(fk.refSchema, quote, engine)}.` : ''}${promptIdentifier(
          fk.refTable,
          quote,
          engine,
        )}.${fk.refColumns.map((c) => promptIdentifier(c, quote, engine)).join(',')}`,
      );
      declared.add(`${t.name.toLowerCase()}.${(fk.columns[0] ?? '').toLowerCase()}`);
    }
  }
  // Infer relationships from `<name>_id` / `<name>Id` columns that match a table name, marked as likely.
  for (const e of inferredRelationships(catalog, declared, multiSchema)) edges.push(e);
  return edges;
}

const singularOf = (name: string): string =>
  name.endsWith('ies')
    ? `${name.slice(0, -3)}y`
    : name.endsWith('ses')
      ? name.slice(0, -2)
      : name.endsWith('s')
        ? name.slice(0, -1)
        : name;

/** FK-column base name, e.g. "client" from "client_id" or "clientId"; null if not a *_id column. */
function fkBase(column: string): string | null {
  const m = /^(.+?)_?id$/i.exec(column);
  if (!m) return null;
  const base = m[1]!.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(); // camelCase -> snake
  return base && base !== '' ? base : null;
}

/** Naming-convention relationships (`<table>_id` -> that table), skipping ones already declared as FKs. */
function inferredRelationships(catalog: SchemaCatalog, declared: ReadonlySet<string>, multiSchema: boolean): string[] {
  const quote = dialectFor(catalog.engine)?.quoteChar ?? '"';
  const engine = catalog.engine;
  // Index every table by its lowercase name and its singular form, so `client_id` finds `clients`.
  const byName = new Map<string, TableInfo>();
  for (const t of catalog.tables) {
    for (const key of [t.name.toLowerCase(), singularOf(t.name.toLowerCase())]) {
      if (!byName.has(key)) byName.set(key, t);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of catalog.tables) {
    for (const c of t.columns) {
      const base = fkBase(c.name);
      if (!base || base === 'i') continue; // "id" itself -> base "" skipped above; guard stray
      if (declared.has(`${t.name.toLowerCase()}.${c.name.toLowerCase()}`)) continue;
      // Try the whole base, then its last underscore-segment (e.g. group_appointment -> appointment).
      const target = byName.get(base) ?? byName.get(base.split('_').pop()!);
      if (!target || target.name.toLowerCase() === t.name.toLowerCase()) continue;
      const pk = target.primaryKey[0] ?? 'id';
      const edge = `${qualifiedName(t, multiSchema, quote, engine)}.${promptIdentifier(c.name, quote, engine)} ~ ${qualifiedName(target, multiSchema, quote, engine)}.${promptIdentifier(pk, quote, engine)}  [inferred from naming]`;
      if (seen.has(edge)) continue;
      seen.add(edge);
      out.push(edge);
    }
  }
  return out;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'for',
  'to',
  'by',
  'and',
  'or',
  'with',
  'show',
  'me',
  'all',
  'list',
  'get',
  'give',
  'what',
  'which',
  'how',
  'many',
  'much',
  'per',
  'top',
  'last',
  'first',
  'is',
  'are',
  'was',
  'were',
  'from',
]);

function terms(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => (w.endsWith('s') && w.length > 3 ? w.slice(0, -1) : w));
}

/** Split snake_case and camelCase identifiers into lowercase words, so "customer_id"/"productName" match "customer"/"product". */
function tokenizeIdentifier(raw: string): string[] {
  return raw
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/u)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1);
}

/** Word-level scoring beats raw substring: a whole-word name hit ranks above an incidental substring, cutting false positives on large schemas. */
function scoreTable(t: TableInfo, qTerms: readonly string[]): number {
  const name = t.name.toLowerCase();
  const nameTokens = new Set(tokenizeIdentifier(t.name));
  const columnTokens = new Set(t.columns.flatMap((c) => tokenizeIdentifier(c.name)));
  const commentHay = [t.comment ?? '', ...t.columns.map((c) => c.comment ?? '')].join(' ').toLowerCase();
  let score = 0;
  for (const term of qTerms) {
    const plural = `${term}s`;
    if (name === term || name === plural) score += 6;
    else if (nameTokens.has(term) || nameTokens.has(plural)) score += 5;
    else if (name.includes(term)) score += 4;
    else if (columnTokens.has(term) || columnTokens.has(plural)) score += 2;
    else if (commentHay.includes(term)) score += 1;
  }
  return score;
}

export interface PruneResult {
  readonly catalog: SchemaCatalog;
  /** The pruned catalog rendered for the prompt - reuse instead of re-rendering. */
  readonly schemaText: string;
  readonly dropped: number;
  readonly strategy: 'none' | 'term-match+fk-closure' | 'budget-trim';
}

/** Deterministic pruning: keep tables matching the question terms, expand one FK hop, then trim to budget. */
/** Never trim a table below this many columns: an unusable stub is worse than a large prompt. */
const MIN_COLUMNS_KEPT = 12;

/** One column's rendered size; [trimColumns] charges the same per column. */
function columnChars(c: TableInfo['columns'][number]): number {
  let chars = c.name.length + c.dbType.length + (c.comment?.length ?? 0) + 24;
  // Sample and enum values are rendered too, capped in formatCatalogForPrompt.
  const values = c.enumValues?.length ? c.enumValues : (c.sampledValues ?? []);
  for (const v of values.slice(0, VALUE_SAMPLE_MAX_DISTINCT)) chars += Math.min(v.length, VALUE_SAMPLE_CAP) + 1;
  return chars;
}

/** Cheap per-table token estimate for budgeting (avoids rendering to measure). */
function estimateTableTokens(t: TableInfo): number {
  let chars = t.name.length + (t.schema?.length ?? 0) + (t.comment?.length ?? 0) + 24;
  for (const c of t.columns) chars += columnChars(c);
  chars += t.foreignKeys.length * 40;
  // Indexes are rendered too, capped at MAX_INDEXES_PER_TABLE.
  for (const i of t.indexes.slice(0, MAX_INDEXES_PER_TABLE)) {
    chars += i.name.length + i.columns.join(',').length + 12;
  }
  return Math.ceil(chars / 4);
}

/** Keep keys first, then question-term matches, then declaration order; reports how many columns were left out. */
function trimColumns(
  t: TableInfo,
  qTerms: ReadonlySet<string>,
  budgetTokens: number,
  referencedByOthers?: ReadonlySet<string>,
): TableInfo {
  if (estimateTableTokens(t) <= budgetTokens || t.columns.length <= MIN_COLUMNS_KEPT) return t;
  const keyNames = new Set<string>([
    ...t.primaryKey,
    ...t.foreignKeys.flatMap((f) => f.columns),
    ...(referencedByOthers ?? []),
  ]);
  const rank = (c: (typeof t.columns)[number]): number => {
    if (keyNames.has(c.name) || keyNames.has(c.name.toLowerCase())) return 0;
    const lower = c.name.toLowerCase();
    for (const term of qTerms) if (lower.includes(term)) return 1;
    return 2;
  };
  const ordered = t.columns.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i);
  // Indices, not names: duplicate spreadsheet headers must be counted separately.
  const keptIndices = new Set<number>();
  let used = estimateTableTokens({ ...t, columns: [] });
  for (const { c, i } of ordered) {
    const cost = Math.ceil(columnChars(c) / 4);
    if (keptIndices.size >= MIN_COLUMNS_KEPT && used + cost > budgetTokens) break;
    keptIndices.add(i);
    used += cost;
  }
  const omitted = t.columns.length - keptIndices.size;
  if (omitted <= 0) return t;
  // The marker has to survive the comment cap, so the original comment yields room for it.
  const marker = `[${omitted} of ${t.columns.length} columns not shown]`;
  const room = COMMENT_CAP - marker.length - 1;
  const existing = t.comment?.replace(/\s+/gu, ' ').trim() ?? '';
  const prefix = existing && room > 0 ? `${existing.slice(0, room)} ` : '';
  return {
    ...t,
    // Restore declaration order so the table still reads like the table.
    columns: t.columns.filter((_, i) => keptIndices.has(i)),
    comment: `${prefix}${marker}`,
  };
}

export function pruneCatalog(catalog: SchemaCatalog, question: string, settings?: PrunerSettings): PruneResult {
  const maxTables = settings?.maxTables ?? 40;
  const maxSchemaTokens = settings?.maxSchemaTokens ?? 6000;
  const all = catalog.tables.filter((t) => !t.partitionOf);

  // Fast path: the whole schema fits; the rendered text is handed back to the caller.
  const fullText = formatCatalogForPrompt({ ...catalog, tables: all });
  if (all.length <= maxTables && estimateTokens(fullText) <= maxSchemaTokens) {
    return {
      catalog: { ...catalog, tables: all },
      schemaText: fullText,
      dropped: catalog.tables.length - all.length,
      strategy: 'none',
    };
  }

  const qTerms = terms(question);
  const scored = all.map((t) => ({ t, score: scoreTable(t, qTerms) })).sort((a, b) => b.score - a.score);

  const seeds = scored.filter((s) => s.score > 0).map((s) => s.t);

  const key = (schema: string | undefined, name: string) => `${schema ?? ''}.${name}`;
  const byName = new Map<string, TableInfo>();
  for (const t of all) {
    byName.set(key(t.schema, t.name), t);
    byName.set(`.${t.name}`, t); // schemaless lookup fallback
  }

  // Undirected FK adjacency so a join chain A-B-C-D is reachable from a seed at either end.
  const neighbors = new Map<string, Set<string>>();
  for (const t of all) {
    const tk = key(t.schema, t.name);
    for (const fk of t.foreignKeys) {
      const ref = byName.get(key(fk.refSchema, fk.refTable)) ?? byName.get(`.${fk.refTable}`);
      if (!ref) continue;
      const rk = key(ref.schema, ref.name);
      (neighbors.get(tk) ?? neighbors.set(tk, new Set()).get(tk)!).add(rk);
      (neighbors.get(rk) ?? neighbors.set(rk, new Set()).get(rk)!).add(tk);
    }
  }

  // BFS out from the seeds up to FK_CLOSURE_HOPS, so multi-join questions get the whole path, bounded by maxTables.
  const expanded = new Set<string>();
  let frontier = new Set(seeds.map((t) => key(t.schema, t.name)));
  for (const k of frontier) expanded.add(k);
  for (let hop = 0; hop < FK_CLOSURE_HOPS && expanded.size < maxTables; hop++) {
    const next = new Set<string>();
    for (const k of frontier) for (const n of neighbors.get(k) ?? []) if (!expanded.has(n)) next.add(n);
    for (const k of next) expanded.add(k);
    frontier = next;
  }

  let candidate = scored.filter((s) => expanded.has(key(s.t.schema, s.t.name)) || s.score > 0).map((s) => s.t);
  if (candidate.length === 0) candidate = scored.slice(0, maxTables).map((s) => s.t);

  // Order best-scored first, then accumulate under the caps in one pass.
  const order = new Map(scored.map((s, i) => [key(s.t.schema, s.t.name), i]));
  candidate.sort((a, b) => (order.get(key(a.schema, a.name)) ?? 0) - (order.get(key(b.schema, b.name)) ?? 0));
  // Reserve part of the budget for the relationships, enums and functions sections.
  const perTableBudget = Math.max(500, maxSchemaTokens - 400);
  const kept: TableInfo[] = [];
  let used = 0;
  for (const t of candidate) {
    if (kept.length >= maxTables) break;
    const cost = estimateTableTokens(t);
    if (kept.length >= 1 && used + cost > perTableBudget) break;
    kept.push(t);
    used += cost;
  }

  // Column trimming runs only when the rendered schema is over budget.
  let finalTables = kept;
  let text = formatCatalogForPrompt({ ...catalog, tables: kept });
  if (estimateTokens(text) > maxSchemaTokens) {
    const perTableBudgetTokens = Math.max(200, Math.floor(maxSchemaTokens / Math.max(1, kept.length)));
    // Columns targeted by any table's foreign key survive trimming, including from tables pruned away.
    const referenced = new Map<string, Set<string>>();
    for (const t of all) {
      for (const fk of t.foreignKeys) {
        const target = fk.refTable.toLowerCase();
        const set = referenced.get(target) ?? new Set<string>();
        for (const c of fk.refColumns) set.add(c.toLowerCase());
        referenced.set(target, set);
      }
    }
    finalTables = kept.map((t) =>
      trimColumns(t, new Set(qTerms), perTableBudgetTokens, referenced.get(t.name.toLowerCase())),
    );
    text = formatCatalogForPrompt({ ...catalog, tables: finalTables });
  }

  return {
    catalog: { ...catalog, tables: finalTables },
    schemaText: text,
    dropped: all.length - kept.length,
    // Column trimming is the reported strategy: the caller warns the table was not shown whole.
    strategy: finalTables.some((t, i) => t !== kept[i]) ? 'budget-trim' : 'term-match+fk-closure',
  };
}
