/**
 * Sampling-based schema inference for MongoDB, which has no declared schema: the catalog comes
 * from sampling up to {@link SAMPLE_SIZE} documents per collection and walking their dotted field
 * paths. Each path records its BSON type(s), the share of documents holding it, and a bounded set
 * of example values, suppressed once the distinct count passes {@link MAX_EXAMPLES}.
 */

import type { ColumnInfo, SchemaCatalog, TableInfo } from '@asksql/core';
import { bsonTypeOf, displayScalar } from './bson.js';
import type { DbLike } from './driver.js';

const SAMPLE_SIZE = 200;
const SAMPLE_MAX_TIME_MS = 15_000;
/** Deepest dotted path level walked (a.b.c.d). */
const MAX_DEPTH = 4;
/** Descend into at most this many document elements of an array. */
const MAX_ARRAY_DESCENT = 5;
/** Distinct dotted paths tracked per collection. */
const MAX_PATHS = 500;
/** Distinct example values kept per path; a further distinct value suppresses them. */
const MAX_EXAMPLES = 20;
/** Collections sampled concurrently. */
const CONCURRENCY = 5;

const EMPTY_COMMENT = 'empty or inaccessible - schema could not be sampled';

interface PathAccumulator {
  readonly types: Set<string>;
  presentDocs: number;
  hadNull: boolean;
  readonly examples: Set<string>;
  capExceeded: boolean;
}

interface DocPath {
  readonly types: Set<string>;
  hadNull: boolean;
  readonly examples: Set<string>;
}

function recordInDoc(
  docPaths: Map<string, DocPath>,
  path: string,
  type: string | null,
  example: string | null,
  isNull: boolean,
): void {
  let entry = docPaths.get(path);
  if (!entry) {
    entry = { types: new Set(), hadNull: false, examples: new Set() };
    docPaths.set(path, entry);
  }
  if (isNull) entry.hadNull = true;
  else if (type) entry.types.add(type);
  if (example !== null) entry.examples.add(example);
}

function walkValue(
  value: unknown,
  path: string,
  depth: number,
  docPaths: Map<string, DocPath>,
  parentOf: Map<string, string>,
): void {
  if (value === null || value === undefined) {
    recordInDoc(docPaths, path, null, null, true);
    return;
  }
  const type = bsonTypeOf(value);
  if (type === 'object') {
    recordInDoc(docPaths, path, 'object', null, false);
    if (depth < MAX_DEPTH) walkObject(value as Record<string, unknown>, path, depth + 1, docPaths, parentOf);
    return;
  }
  if (type === 'array') {
    const arr = value as unknown[];
    const elem = arr.length > 0 ? bsonTypeOf(arr[0]) : null;
    recordInDoc(docPaths, path, elem ? `array<${elem}>` : 'array', null, false);
    if (depth < MAX_DEPTH) {
      let descended = 0;
      for (const el of arr) {
        if (descended >= MAX_ARRAY_DESCENT) break;
        if (el !== null && el !== undefined && bsonTypeOf(el) === 'object') {
          walkObject(el as Record<string, unknown>, path, depth + 1, docPaths, parentOf);
          descended += 1;
        }
      }
    }
    return;
  }
  recordInDoc(docPaths, path, type, displayScalar(value), false);
}

function walkObject(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  docPaths: Map<string, DocPath>,
  /** Path to its true parent, filled as the walk descends. The empty string means the document root. */
  parentOf: Map<string, string>,
): void {
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // The parent is recorded as the walk descends. Recovering it from the path text cannot work: a key
    // may itself contain dots, and a prefix colliding with a real field steals the split, leaving only
    // the tail to be judged - which is how `latency.{"db.internal"}` kept its key as a column name.
    parentOf.set(path, prefix);
    walkValue(val, path, depth, docPaths, parentOf);
  }
}

function mergeDoc(stats: Map<string, PathAccumulator>, docPaths: Map<string, DocPath>): void {
  for (const [path, entry] of docPaths) {
    let acc = stats.get(path);
    if (!acc) {
      if (stats.size >= MAX_PATHS) continue;
      acc = { types: new Set(), presentDocs: 0, hadNull: false, examples: new Set(), capExceeded: false };
      stats.set(path, acc);
    }
    acc.presentDocs += 1;
    if (entry.hadNull) acc.hadNull = true;
    for (const t of entry.types) acc.types.add(t);
    if (!acc.capExceeded) {
      for (const ex of entry.examples) {
        if (acc.examples.has(ex)) continue;
        if (acc.examples.size >= MAX_EXAMPLES) {
          acc.capExceeded = true;
          acc.examples.clear();
          break;
        }
        acc.examples.add(ex);
      }
    }
  }
}

/** A child field is part of the record's shape once it recurs in this share of the parent's documents. */
const STABLE_CHILD_RATIO = 0.6;

/** A path segment that reads as a field name; one that does not is a key, which is data. */
const FIELD_SEGMENT = /^[\p{L}_][\p{L}\p{N}_]{0,39}$/u;

/** Documents per child, averaged, below which the names look like keys rather than a record's fields. */
const MIN_CHILD_REUSE = 2;

/** Below this many documents holding the parent, reuse says nothing, so only the key's shape decides. */
const MIN_DOCS_FOR_REUSE = 3;

/** More children than a record plausibly has; past this, saturated names are still a map's keys. */
const MAX_RECORD_FIELDS = 12;

/** Stands in for the document root, which is a parent with no column of its own. */
const ROOT = '\u0000root';

/**
 * Paths whose children are data rather than field names. `{ owed: { "ada@example.com": 120 } }` makes
 * every address a column NAME, and a name is never stripped by the data opt-in, so those reach the
 * prompt by default. A record repeats its fields across documents; a map does not.
 *
 * Judged per child, so a summary field beside the keys keeps its name. Shape decides first, then
 * reuse. Known residual: a small fixed key set present on every document still reads as a record.
 *
 * Returns each parent's data-bearing child paths.
 */
function mapShapedPaths(
  stats: Map<string, PathAccumulator>,
  totalDocs: number,
  parentOf: Map<string, string>,
): Map<string, string[]> {
  const childrenOf = new Map<string, string[]>();
  for (const path of stats.keys()) {
    const parent = parentOf.get(path) || ROOT;
    const list = childrenOf.get(parent);
    if (list) list.push(path);
    else childrenOf.set(parent, [path]);
  }

  const collapse = new Map<string, string[]>();
  for (const [parent, children] of childrenOf) {
    const acc = parent === ROOT ? { presentDocs: totalDocs } : stats.get(parent);
    if (!acc) continue;
    const needed = Math.max(MIN_CHILD_REUSE, acc.presentDocs * STABLE_CHILD_RATIO);
    // Only children that could be fields count towards saturation; dotted keys beside one real field
    // otherwise diluted the test and the field was deleted.
    const nameable = children.filter((c) => FIELD_SEGMENT.test(parent === ROOT ? c : c.slice(parent.length + 1)));
    const occurrences = nameable.reduce((n, c) => n + (stats.get(c)?.presentDocs ?? 0), 0);
    // Capped as well as summed: the average alone only asks whether names recur twice each, which any
    // large map satisfies, and recurrence rises with the sample size.
    const keysRecur = nameable.length <= MAX_RECORD_FIELDS && occurrences >= nameable.length * MIN_CHILD_REUSE;
    // At the ROOT shape decides alone: one document per integration is ordinary and its names do not
    // recur, so judging the root by reuse returned a catalog of just `_id`.
    const enoughEvidence = parent !== ROOT && acc.presentDocs >= MIN_DOCS_FOR_REUSE;
    const data = children.filter((child) => {
      const segment = parent === ROOT ? child : child.slice(parent.length + 1);
      if (!FIELD_SEGMENT.test(segment)) return true;
      return enoughEvidence && !keysRecur && (stats.get(child)?.presentDocs ?? 0) < needed;
    });
    if (data.length === 0) continue;
    // A lone field-shaped child is a sparse field, not a map; dropping it would lose a real name.
    const firstSegment = parent === ROOT ? data[0]! : data[0]!.slice(parent.length + 1);
    if (data.length < 2 && FIELD_SEGMENT.test(firstSegment)) continue;
    collapse.set(parent, data);
  }
  return collapse;
}

function buildColumns(
  stats: Map<string, PathAccumulator>,
  totalSampled: number,
  sampleColumnValues: boolean,
  parentOf: Map<string, string>,
): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  const collapse = mapShapedPaths(stats, totalSampled, parentOf);
  const dataKeys = [...collapse.values()].flat();
  for (const [path, acc] of stats) {
    // A key of a map-shaped path is data, not a field: it must not become a column name.
    if (dataKeys.some((key) => path === key || path.startsWith(`${key}.`))) continue;
    const types = [...acc.types].sort();
    const dbType = types.length === 0 ? 'unknown' : types.length === 1 ? types[0]! : `mixed(${types.join('|')})`;
    const nullable = acc.hadNull || acc.presentDocs < totalSampled;
    const pct = totalSampled > 0 ? Math.round((acc.presentDocs / totalSampled) * 100) : 0;
    const column: ColumnInfo = {
      name: path,
      dbType,
      nullable,
      comment:
        path !== ROOT && collapse.has(path)
          ? `map-shaped: its keys are data, not field names (${collapse.get(path)!.length} distinct keys in ` +
            `${totalSampled} sampled documents); read with $objectToArray`
          : `present in ${pct}% of ${totalSampled} sampled documents`,
      ...(sampleColumnValues && !acc.capExceeded && acc.examples.size > 0 ? { sampledValues: [...acc.examples] } : {}),
    };
    columns.push(column);
  }
  // Surface _id first regardless of first-seen order.
  columns.sort((a, b) => (a.name === '_id' ? -1 : b.name === '_id' ? 1 : 0));
  return columns;
}

/**
 * Pure field inference over already-sampled documents: walk each document's
 * dotted paths, merge per-document stats, and emit one ColumnInfo per path.
 */
export function inferColumns(docs: readonly Record<string, unknown>[], sampleColumnValues: boolean): ColumnInfo[] {
  const stats = new Map<string, PathAccumulator>();
  const parentOf = new Map<string, string>();
  for (const doc of docs) {
    const docPaths = new Map<string, DocPath>();
    walkObject(doc, '', 1, docPaths, parentOf);
    mergeDoc(stats, docPaths);
  }
  return buildColumns(stats, docs.length, sampleColumnValues, parentOf);
}

async function estimateCount(db: DbLike, name: string): Promise<number | null> {
  try {
    return await db.collection(name).estimatedDocumentCount({ maxTimeMS: SAMPLE_MAX_TIME_MS });
  } catch {
    return null;
  }
}

async function introspectCollection(
  db: DbLike,
  name: string,
  sampleColumnValues: boolean,
  warnings: string[],
): Promise<TableInfo> {
  const rowEstimate = await estimateCount(db, name);
  let docs: Record<string, unknown>[];
  try {
    docs = await db
      .collection(name)
      .aggregate([{ $sample: { size: SAMPLE_SIZE } }], {
        maxTimeMS: SAMPLE_MAX_TIME_MS,
        promoteValues: false,
        promoteLongs: false,
        promoteBuffers: false,
      })
      .toArray();
  } catch (err) {
    warnings.push(`Could not sample collection '${name}': ${err instanceof Error ? err.message : String(err)}`);
    return emptyTable(name, rowEstimate);
  }

  if (docs.length === 0) return emptyTable(name, rowEstimate);

  const columns = inferColumns(docs, sampleColumnValues);
  // Hitting the path cap means fields exist that the model is never shown, so it concludes they do not
  // exist. A document store has no DDL to check against, which makes an unannounced cut unrecoverable.
  if (columns.length >= MAX_PATHS) {
    warnings.push(
      `Collection '${name}' has more than ${MAX_PATHS} distinct fields; only the first ${MAX_PATHS} are described.`,
    );
  }

  return {
    name,
    kind: 'table',
    columns,
    primaryKey: ['_id'],
    foreignKeys: [],
    uniques: [],
    checks: [],
    indexes: [],
    rowEstimate,
    comment: null,
  };
}

function emptyTable(name: string, rowEstimate: number | null): TableInfo {
  return {
    name,
    kind: 'table',
    columns: [],
    primaryKey: ['_id'],
    foreignKeys: [],
    uniques: [],
    checks: [],
    indexes: [],
    rowEstimate,
    comment: EMPTY_COMMENT,
  };
}

export async function introspectMongo(
  db: DbLike,
  opts: { database: string; sampleColumnValues: boolean },
): Promise<SchemaCatalog> {
  const warnings: string[] = [];
  const entries = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = entries.map((e) => e.name).filter((n) => !n.startsWith('system.'));

  const tables: TableInfo[] = [];
  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const chunk = names.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((name) => introspectCollection(db, name, opts.sampleColumnValues, warnings)),
    );
    tables.push(...results);
  }

  return {
    engine: 'mongodb',
    schemas: [opts.database],
    tables,
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
