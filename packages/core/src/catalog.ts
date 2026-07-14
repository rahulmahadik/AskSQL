/**
 * SchemaCatalog utilities: prompt formatting, deterministic pruning
 * (name/term match + FK-closure expansion, tier 1) and the join
 * graph derived from foreign keys - the #1 accuracy lever.
 */

import type {
  PrunerSettings,
  SchemaCatalog,
  TableInfo,
} from './types.js';

/** Cheap token estimate (~4 chars per token) for budget decisions only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const COMMENT_CAP = 200;

function sanitizeComment(comment: string | null | undefined): string | null {
  if (!comment) return null;
  const flat = comment.replace(/\s+/gu, ' ').trim();
  if (!flat) return null;
  return flat.length > COMMENT_CAP ? `${flat.slice(0, COMMENT_CAP)}…` : flat;
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
    const head =
      t.kind === 'view'
        ? 'VIEW'
        : t.kind === 'materialized_view'
          ? 'MATERIALIZED VIEW'
          : 'TABLE';
    const comment = sanitizeComment(t.comment);
    const est =
      typeof t.rowEstimate === 'number' && t.rowEstimate >= 0
        ? ` [~${Math.round(t.rowEstimate)} rows]`
        : '';
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
        bits.push(`values: ${c.enumValues.slice(0, 24).join('|')}`);
      }
      const colComment = sanitizeComment(c.comment);
      if (colComment) bits.push(`-- ${colComment}`);
      lines.push(bits.join(' '));
    }
  }

  if (catalog.enums.length > 0) {
    lines.push('ENUM TYPES:');
    for (const e of catalog.enums) {
      lines.push(` ${e.name}: ${e.values.slice(0, 32).join('|')}`);
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
  for (const t of catalog.tables) {
    for (const fk of t.foreignKeys) {
      edges.push(
        `${qualifiedName(t, multiSchema)}.${fk.columns.join(',')} = ${
          fk.refSchema && multiSchema ? `${fk.refSchema}.` : ''
        }${fk.refTable}.${fk.refColumns.join(',')}`,
      );
    }
  }
  return edges;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'by', 'and', 'or', 'with',
  'show', 'me', 'all', 'list', 'get', 'give', 'what', 'which', 'how', 'many',
  'much', 'per', 'top', 'last', 'first', 'is', 'are', 'was', 'were', 'from',
]);

function terms(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => (w.endsWith('s') && w.length > 3 ? w.slice(0, -1) : w));
}

function scoreTable(t: TableInfo, qTerms: readonly string[]): number {
  const hay = [
    t.name,
    t.schema ?? '',
    t.comment ?? '',
    ...t.columns.map((c) => c.name),
    ...t.columns.map((c) => c.comment ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const term of qTerms) {
    if (!hay.includes(term)) continue;
    // Table-name hits dominate column hits; comment hits count least.
    const name = t.name.toLowerCase();
    if (name === term || name === `${term}s` || name.includes(term)) score += 5;
    else if (t.columns.some((c) => c.name.toLowerCase().includes(term))) score += 2;
    else score += 1;
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
  for (const c of t.columns) chars += c.name.length + c.dbType.length + (c.comment?.length ?? 0) + 24;
  chars += t.foreignKeys.length * 40;
  return Math.ceil(chars / 4);
}

export function pruneCatalog(
  catalog: SchemaCatalog,
  question: string,
  settings?: PrunerSettings,
): PruneResult {
  const maxTables = settings?.maxTables ?? 40;
  const maxSchemaTokens = settings?.maxSchemaTokens ?? 6000;
  const all = catalog.tables.filter((t) => !t.partitionOf);

// Fast path: the whole schema fits. Render ONCE and hand the text back so
// the caller doesn't re-render it.
const fullText = formatCatalogForPrompt({...catalog, tables: all });
if (all.length <= maxTables && estimateTokens(fullText) <= maxSchemaTokens) {
  return {
    catalog: {...catalog, tables: all },
    schemaText: fullText,
    dropped: catalog.tables.length - all.length,
    strategy: 'none',
};
  }

  const qTerms = terms(question);
  const scored = all
    .map((t) => ({ t, score: scoreTable(t, qTerms) }))
    .sort((a, b) => b.score - a.score);

  const seeds = scored.filter((s) => s.score > 0).map((s) => s.t);
  const seedSet = new Set(seeds.map((t) => `${t.schema ?? ''}.${t.name}`));

  // One-hop FK closure in both directions so join paths stay intact.
  const key = (schema: string | undefined, name: string) => `${schema ?? ''}.${name}`;
  const byName = new Map<string, TableInfo>();
  for (const t of all) {
    byName.set(key(t.schema, t.name), t);
    byName.set(`.${t.name}`, t); // schemaless lookup fallback
  }
  const expanded = new Set(seedSet);
  for (const t of seeds) {
    for (const fk of t.foreignKeys) {
      const ref = byName.get(key(fk.refSchema, fk.refTable)) ?? byName.get(`.${fk.refTable}`);
      if (ref) expanded.add(key(ref.schema, ref.name));
    }
  }
  for (const t of all) {
    for (const fk of t.foreignKeys) {
      const refKey = key(fk.refSchema, fk.refTable);
      if (seedSet.has(refKey) || seedSet.has(`.${fk.refTable}`)) {
        expanded.add(key(t.schema, t.name));
      }
    }
  }

let candidate = scored
    .filter((s) => expanded.has(key(s.t.schema, s.t.name)) || s.score > 0)
    .map((s) => s.t);
    if (candidate.length === 0) candidate = scored.slice(0, maxTables).map((s) => s.t);

// Order best-scored first, then accumulate under the caps in ONE pass
// (per-table token estimate, no repeated full-catalog rendering).
  const order = new Map(scored.map((s, i) => [key(s.t.schema, s.t.name), i]));
  candidate.sort(
    (a, b) => (order.get(key(a.schema, a.name)) ?? 0) - (order.get(key(b.schema, b.name)) ?? 0),
  );
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
    catalog: {...catalog, tables: kept },
    schemaText: formatCatalogForPrompt({...catalog, tables: kept }),
    dropped: all.length - kept.length,
    strategy: kept.length < all.length ? 'term-match+fk-closure' : 'budget-trim',
  };
}
