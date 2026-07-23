/**
 * SchemaCatalog utilities: prompt formatting, deterministic pruning
 * (name/term match + FK-closure expansion, tier 1) and the join
 * graph derived from foreign keys - the #1 accuracy lever.
 */

import type { PrunerSettings, SchemaCatalog, TableInfo } from './types.js';
import { VALUE_SAMPLE_MAX_DISTINCT } from './types.js';

/** Cheap token estimate (~4 chars per token) for budget decisions only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const COMMENT_CAP = 200;
/** FK-closure BFS depth: a 2-hop chain (A-B-C) survives from one matched seed. */
const FK_CLOSURE_HOPS = 2;
/** Max length of a single rendered sample/enum value. */
const VALUE_SAMPLE_CAP = 80;

/**
 * A sampled/enum value rendered into the schema. `|` is the value separator, so a
 * value containing it would corrupt the list; whitespace is flattened and length
 * capped so one long value cannot dominate the prompt.
 */
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

function qualifiedName(t: TableInfo, multiSchema: boolean): string {
  return multiSchema && t.schema ? `${t.schema}.${t.name}` : t.name;
}

/**
 * Render a catalog as compact prompt text. Comments are included as
 * semantic hints but the prompt wraps the whole block as untrusted data
 * (see prompt.ts /).
 */
export function formatCatalogForPrompt(catalog: SchemaCatalog): string {
  const multiSchema = catalog.schemas.length > 1;
  const lines: string[] = [];

  for (const t of catalog.tables) {
    if (t.partitionOf) continue; // collapsed to parent
    const head = t.kind === 'view' ? 'VIEW' : t.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'TABLE';
    const comment = sanitizeComment(t.comment);
    const est = typeof t.rowEstimate === 'number' && t.rowEstimate >= 0 ? ` [~${Math.round(t.rowEstimate)} rows]` : '';
    lines.push(
      `${head} ${qualifiedName(t, multiSchema)}${est}${comment ? ` -- ${comment}` : ''}${
        t.source === 'file' ? ' [from uploaded file]' : ''
      }`,
    );
    for (const c of t.columns) {
      const bits: string[] = [` ${c.name} ${c.dbType}`];
      if (t.primaryKey.includes(c.name)) bits.push('PK');
      const fk = t.foreignKeys.find((f) => f.columns.includes(c.name));
      if (fk) bits.push(`FK->${fk.refSchema ? `${fk.refSchema}.` : ''}${fk.refTable}.${fk.refColumns.join(',')}`);
      if (!c.nullable) bits.push('NOT NULL');
      if (c.enumValues && c.enumValues.length > 0) {
        bits.push(`values: ${c.enumValues.slice(0, VALUE_SAMPLE_MAX_DISTINCT).map(sanitizeValue).join('|')}`);
      } else if (c.sampledValues && c.sampledValues.length > 0) {
        // Observed values (data, opt-in), not a declared enum - label them so
        // the model treats them as the known-so-far set, not an exhaustive one.
        bits.push(`sample values: ${c.sampledValues.slice(0, VALUE_SAMPLE_MAX_DISTINCT).map(sanitizeValue).join('|')}`);
      }
      const colComment = sanitizeComment(c.comment);
      if (colComment) bits.push(`-- ${colComment}`);
      lines.push(bits.join(' '));
    }
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
  const edges: string[] = [];
  const declared = new Set<string>();
  for (const t of catalog.tables) {
    for (const fk of t.foreignKeys) {
      edges.push(
        `${qualifiedName(t, multiSchema)}.${fk.columns.join(',')} = ${
          fk.refSchema && multiSchema ? `${fk.refSchema}.` : ''
        }${fk.refTable}.${fk.refColumns.join(',')}`,
      );
      declared.add(`${t.name.toLowerCase()}.${(fk.columns[0] ?? '').toLowerCase()}`);
    }
  }
  // Many real databases (esp. MySQL apps) declare few or no FK constraints, so the
  // declared graph is near-empty. Infer relationships from `<name>_id` / `<name>Id`
  // columns that point at a table whose name matches - conservative (a matching table
  // must exist), and marked so the model treats them as likely, not guaranteed.
  for (const e of inferredRelationships(catalog, declared, multiSchema)) edges.push(e);
  return edges;
}

const singularOf = (name: string): string =>
  name.endsWith('ies') ? `${name.slice(0, -3)}y` : name.endsWith('ses') ? name.slice(0, -2) : name.endsWith('s') ? name.slice(0, -1) : name;

/** FK-column base name, e.g. "client" from "client_id" or "clientId"; null if not a *_id column. */
function fkBase(column: string): string | null {
  const m = /^(.+?)_?id$/i.exec(column);
  if (!m) return null;
  const base = m[1]!.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(); // camelCase -> snake
  return base && base !== '' ? base : null;
}

/** Naming-convention relationships (`<table>_id` -> that table), skipping ones already declared as FKs. */
function inferredRelationships(catalog: SchemaCatalog, declared: ReadonlySet<string>, multiSchema: boolean): string[] {
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
      const edge = `${qualifiedName(t, multiSchema)}.${c.name} ~ ${qualifiedName(target, multiSchema)}.${pk}  [inferred from naming]`;
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

/**
 * Deterministic pruning (tier 1): keep tables whose name/columns/
 * comments overlap the question terms, expand one FK hop in both
 * directions so join paths survive, then trim to budget by score.
 */
/** Cheap per-table token estimate for budgeting (avoids rendering to measure). */
function estimateTableTokens(t: TableInfo): number {
  let chars = t.name.length + (t.schema?.length ?? 0) + (t.comment?.length ?? 0) + 24;
  for (const c of t.columns) {
    chars += c.name.length + c.dbType.length + (c.comment?.length ?? 0) + 24;
    // Values are rendered too (capped in formatCatalogForPrompt), so a column with
    // many sample values must not be budgeted as if it had none.
    const values = c.enumValues?.length ? c.enumValues : (c.sampledValues ?? []);
    for (const v of values.slice(0, VALUE_SAMPLE_MAX_DISTINCT)) chars += Math.min(v.length, VALUE_SAMPLE_CAP) + 1;
  }
  chars += t.foreignKeys.length * 40;
  return Math.ceil(chars / 4);
}

export function pruneCatalog(catalog: SchemaCatalog, question: string, settings?: PrunerSettings): PruneResult {
  const maxTables = settings?.maxTables ?? 40;
  const maxSchemaTokens = settings?.maxSchemaTokens ?? 6000;
  const all = catalog.tables.filter((t) => !t.partitionOf);

  // Fast path: the whole schema fits. Render once and hand the text back so
  // the caller doesn't re-render it.
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

  // Order best-scored first, then accumulate under the caps in one pass
  // (per-table token estimate, no repeated full-catalog rendering).
  const order = new Map(scored.map((s, i) => [key(s.t.schema, s.t.name), i]));
  candidate.sort((a, b) => (order.get(key(a.schema, a.name)) ?? 0) - (order.get(key(b.schema, b.name)) ?? 0));
  // Reserve part of the budget for the non-per-table sections (relationships,
  // enums, callable functions) that formatCatalogForPrompt also emits.
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

  return {
    catalog: { ...catalog, tables: kept },
    schemaText: formatCatalogForPrompt({ ...catalog, tables: kept }),
    dropped: all.length - kept.length,
    strategy: kept.length < all.length ? 'term-match+fk-closure' : 'budget-trim',
  };
}
