/**
 * Sampling-based schema inference for MongoDB.
 *
 * MongoDB has no declared schema, so the "catalog" is inferred by sampling up
 * to {@link SAMPLE_SIZE} documents per collection and walking their dotted field
 * paths. Per path we record the BSON type(s), how often the field is present
 * (document-count, not occurrence-count), and a bounded set of example values.
 * A field whose distinct-value count exceeds a cap has its examples suppressed
 * so a high-cardinality field is never misreported as a small enum.
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

function walkValue(value: unknown, path: string, depth: number, docPaths: Map<string, DocPath>): void {
  if (value === null || value === undefined) {
    recordInDoc(docPaths, path, null, null, true);
    return;
  }
  const type = bsonTypeOf(value);
  if (type === 'object') {
    recordInDoc(docPaths, path, 'object', null, false);
    if (depth < MAX_DEPTH) walkObject(value as Record<string, unknown>, path, depth + 1, docPaths);
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
          walkObject(el as Record<string, unknown>, path, depth + 1, docPaths);
          descended += 1;
        }
      }
    }
    return;
  }
  recordInDoc(docPaths, path, type, displayScalar(value), false);
}

function walkObject(obj: Record<string, unknown>, prefix: string, depth: number, docPaths: Map<string, DocPath>): void {
  for (const [key, val] of Object.entries(obj)) {
    walkValue(val, prefix ? `${prefix}.${key}` : key, depth, docPaths);
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

function buildColumns(
  stats: Map<string, PathAccumulator>,
  totalSampled: number,
  sampleColumnValues: boolean,
): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  for (const [path, acc] of stats) {
    const types = [...acc.types].sort();
    const dbType = types.length === 0 ? 'unknown' : types.length === 1 ? types[0]! : `mixed(${types.join('|')})`;
    const nullable = acc.hadNull || acc.presentDocs < totalSampled;
    const pct = totalSampled > 0 ? Math.round((acc.presentDocs / totalSampled) * 100) : 0;
    const column: ColumnInfo = {
      name: path,
      dbType,
      nullable,
      comment: `present in ${pct}% of ${totalSampled} sampled documents`,
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
  for (const doc of docs) {
    const docPaths = new Map<string, DocPath>();
    walkObject(doc, '', 1, docPaths);
    mergeDoc(stats, docPaths);
  }
  return buildColumns(stats, docs.length, sampleColumnValues);
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

  return {
    name,
    kind: 'table',
    columns: inferColumns(docs, sampleColumnValues),
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
