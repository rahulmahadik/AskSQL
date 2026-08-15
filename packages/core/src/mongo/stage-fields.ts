/**
 * Field references a pipeline cannot resolve. A `$group` replaces the document, so afterwards only
 * `_id` and the accumulator outputs exist and MongoDB reports anything else from inside the plan
 * executor rather than in terms of the field.
 *
 * Only provable absences count: the catalog is sampled, so checking starts once a stage has narrowed
 * the document to a set computed here, and unmodellable stages stop the walk instead of guessing.
 */

/** Stages whose effect on the document shape this module can reproduce exactly. */
const MODELLED = new Set([
  '$group',
  '$count',
  '$project',
  '$addFields',
  '$set',
  '$unset',
  '$lookup',
  '$unwind',
  '$match',
  '$sort',
  '$limit',
  '$skip',
  '$sample',
]);

export interface UnknownStageField {
  readonly field: string;
  /** Zero-based index of the stage that references it. */
  readonly stage: number;
  /** What the document does hold at that point, for the repair message. */
  readonly available: readonly string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The root of a field path: `$items.qty` is rooted at `items`, which is what a stage can drop. */
function rootOf(ref: string): string | null {
  if (!ref.startsWith('$') || ref.startsWith('$$')) return null;
  const path = ref.slice(1);
  if (path.length === 0) return null;
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
}

/** Every `"$field"` reference in expression position, in document order. */
function fieldRefsIn(node: unknown, out: string[]): void {
  // {$literal: "$x"} is the string "$x", not a reference to x - that is the whole point of $literal.
  if (isRecord(node) && Object.keys(node).length === 1 && '$literal' in node) return;
  if (typeof node === 'string') {
    const root = rootOf(node);
    if (root) out.push(root);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) fieldRefsIn(v, out);
    return;
  }
  if (isRecord(node)) {
    for (const v of Object.values(node)) fieldRefsIn(v, out);
  }
}

/** Names a `$project`/`$addFields` stage puts into the document. */
function projectedNames(spec: Record<string, unknown>, inclusion: boolean): Set<string> {
  const names = new Set<string>();
  for (const [k, v] of Object.entries(spec)) {
    if (k === '_id') {
      // `_id: 0` drops it; anything else keeps or recomputes it.
      if (v !== 0 && v !== false) names.add('_id');
      continue;
    }
    if (inclusion && (v === 0 || v === false)) continue;
    names.add(k.split('.')[0]!);
  }
  if (inclusion && !Object.prototype.hasOwnProperty.call(spec, '_id')) names.add('_id');
  return names;
}

/** True when a `$project` selects fields rather than removing them. */
function isInclusionProjection(spec: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(spec)) {
    if (k === '_id') continue;
    if (v === 0 || v === false) return false;
    return true;
  }
  // Only _id was named: {_id: 0} drops it and keeps everything else, which is an exclusion.
  return !(spec['_id'] === 0 || spec['_id'] === false);
}

export interface MisquotedField {
  /** The path as written, without the leading `$`. */
  readonly raw: string;
  /** The catalog field it was meant to be. */
  readonly suggestion: string;
}

/** Quoting a segment the way SQL would: MongoDB reads the quotes as part of the name. */
function unquoteSegment(segment: string): string {
  const pairs: readonly (readonly [string, string])[] = [
    ['`', '`'],
    ['"', '"'],
    ["'", "'"],
    ['[', ']'],
  ];
  for (const [open, close] of pairs) {
    if (segment.length > 1 && segment.startsWith(open) && segment.endsWith(close)) {
      return segment.slice(1, -1);
    }
  }
  return segment;
}

/**
 * A field reference carrying SQL quoting. `$\`total amount\`` names a field that does not exist, so
 * an aggregate over it returns 0 rather than failing. Reported only when the unquoted form is a
 * catalog field, which makes the mistake provable.
 */
export function firstMisquotedField(
  pipeline: readonly unknown[],
  catalogFields: ReadonlySet<string>,
): MisquotedField | null {
  const refs: string[] = [];
  collectPaths(pipeline, refs);
  for (const raw of refs) {
    if (catalogFields.has(raw)) continue;
    const unquoted = raw.split('.').map(unquoteSegment).join('.');
    if (unquoted !== raw && catalogFields.has(unquoted)) {
      return { raw, suggestion: unquoted };
    }
  }
  return null;
}

/** Full `$field.path` references anywhere in a pipeline, quoting and all. */
function collectPaths(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    if (node.startsWith('$') && !node.startsWith('$$') && node.length > 1) out.push(node.slice(1));
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectPaths(v, out);
    return;
  }
  if (isRecord(node)) {
    for (const v of Object.values(node)) collectPaths(v, out);
  }
}

/** The first field reference the pipeline provably cannot resolve, or null. */
export function firstUnknownStageField(pipeline: readonly unknown[]): UnknownStageField | null {
  // Null until a stage narrows the document; before that the shape is sampled, so absence proves nothing.
  let available: Set<string> | null = null;

  for (let i = 0; i < pipeline.length; i++) {
    const stage = pipeline[i];
    if (!isRecord(stage)) return null;
    const keys = Object.keys(stage);
    if (keys.length !== 1) return null;
    const name = keys[0]!;
    const spec = stage[name];

    // $replaceRoot, $facet, $unionWith and anything unrecognised: sub-pipelines carry their own scope.
    if (!MODELLED.has(name)) return null;

    if (available) {
      const refs: string[] = [];
      if (name === '$lookup' && isRecord(spec)) {
        // A sub-pipeline reads the foreign collection; only localField and `let` come from this one.
        fieldRefsIn(spec['localField'], refs);
        fieldRefsIn(spec['let'], refs);
      } else {
        fieldRefsIn(spec, refs);
      }
      for (const ref of refs) {
        if (!available.has(ref)) {
          return { field: ref, stage: i, available: [...available].sort() };
        }
      }
    }

    switch (name) {
      case '$group': {
        if (!isRecord(spec)) return null;
        available = new Set(Object.keys(spec));
        break;
      }
      case '$count': {
        if (typeof spec !== 'string') return null;
        available = new Set([spec]);
        break;
      }
      case '$project': {
        if (!isRecord(spec)) return null;
        const inclusion = isInclusionProjection(spec);
        if (!inclusion) {
          // An exclusion projection only removes names, so it narrows a set we already know. A dotted
          // key removes one sub-field and leaves the parent, so only a bare name drops the root.
          if (available) for (const k of Object.keys(spec)) if (!k.includes('.')) available.delete(k);
          break;
        }
        available = projectedNames(spec, true);
        break;
      }
      case '$addFields':
      case '$set': {
        if (!isRecord(spec)) return null;
        if (available) for (const k of Object.keys(spec)) available.add(k.split('.')[0]!);
        break;
      }
      case '$unset': {
        const names = typeof spec === 'string' ? [spec] : Array.isArray(spec) ? spec : null;
        if (!names) return null;
        // As above: `$unset: "customer.ssn"` keeps `customer`, so a sibling sub-field still resolves.
        if (available) for (const n of names) if (typeof n === 'string' && !n.includes('.')) available.delete(n);
        break;
      }
      case '$lookup': {
        if (!isRecord(spec)) return null;
        const as = spec['as'];
        if (typeof as !== 'string') return null;
        if (available) available.add(as.split('.')[0]!);
        break;
      }
      case '$unwind': {
        // includeArrayIndex adds its name to every document the stage emits.
        if (isRecord(spec) && typeof spec['includeArrayIndex'] === 'string' && available) {
          available.add(spec['includeArrayIndex'].split('.')[0]!);
        }
        // Unwinding replaces an array with its element; the field itself remains.
        break;
      }
      case '$match':
      case '$sort':
      case '$limit':
      case '$skip':
      case '$sample':
        break;
      default:
        return null;
    }
  }
  return null;
}
