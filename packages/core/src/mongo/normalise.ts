/**
 * Meaning-preserving pipeline rewrites, applied before the guard and re-validated by it. Each one
 * matches a single exact shape and returns null otherwise, leaving the original pipeline in place.
 */

type Doc = Record<string, unknown>;

const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The single key of a one-key document, or null. */
function soleKey(doc: Doc): string | null {
  const keys = Object.keys(doc);
  return keys.length === 1 ? keys[0]! : null;
}

/** Counts how often `$name` appears anywhere in a value tree. */
function referenceCount(node: unknown, ref: string): number {
  if (typeof node === 'string') return node === ref ? 1 : 0;
  if (Array.isArray(node)) return node.reduce<number>((n, v) => n + referenceCount(v, ref), 0);
  if (isDoc(node)) return Object.values(node).reduce<number>((n, v) => n + referenceCount(v, ref), 0);
  return 0;
}

/**
 * Rewrites the `$addToSet` + `$size` distinct count, which the guard refuses because the array must
 * fit in one 16MB document, into a grouped count that spills to disk instead:
 *
 *   [{$group: {_id: null, r: {$addToSet: "$region"}}}, {$project: {n: {$size: "$r"}}}]
 *   -> [{$match: {region: {$exists: true}}}, {$group: {_id: "$region"}}, {$count: "n"}]
 *
 * Requires a global group holding that one accumulator, with the array read exactly once.
 */
export function rewriteDistinctCount(pipeline: readonly unknown[]): unknown[] | null {
  if (pipeline.length < 2) return null;

  const groupStage = pipeline[0];
  const projectStage = pipeline[1];
  if (!isDoc(groupStage) || !isDoc(projectStage)) return null;
  if (soleKey(groupStage) !== '$group') return null;

  const group = groupStage['$group'];
  if (!isDoc(group)) return null;
  // A non-null _id means per-group distinct counts, which is a different question.
  if (group['_id'] !== null) return null;

  const accumulators = Object.keys(group).filter((k) => k !== '_id');
  if (accumulators.length !== 1) return null;
  const arrayName = accumulators[0]!;
  const accumulator = group[arrayName];
  if (!isDoc(accumulator) || soleKey(accumulator) !== '$addToSet') return null;

  const field = accumulator['$addToSet'];
  // Only a plain field path: an expression could depend on the document in ways grouping changes.
  if (typeof field !== 'string' || !field.startsWith('$') || field.startsWith('$$')) return null;

  const projectKey = soleKey(projectStage);
  if (projectKey !== '$project' && projectKey !== '$addFields' && projectKey !== '$set') return null;
  const projection = projectStage[projectKey];
  if (!isDoc(projection)) return null;

  const ref = `$${arrayName}`;
  // The array must be read exactly once, by the $size that turns it into a count.
  if (referenceCount(projection, ref) !== 1) return null;

  const outputs = Object.keys(projection).filter((k) => k !== '_id');
  if (outputs.length !== 1) return null;
  const countName = outputs[0]!;
  const sizeExpr = projection[countName];
  if (!isDoc(sizeExpr) || soleKey(sizeExpr) !== '$size' || sizeExpr['$size'] !== ref) return null;

  // Nothing after these two stages may mention the array either.
  const rest = pipeline.slice(2);
  if (referenceCount(rest, ref) !== 0) return null;

  // $addToSet skips a document whose field is missing; $group would collect those into a null bucket
  // and report one distinct value too many, so the match drops them first.
  return [
    { $match: { [field.slice(1)]: { $exists: true } } },
    { $group: { _id: field } },
    { $count: countName },
    ...rest,
  ];
}
