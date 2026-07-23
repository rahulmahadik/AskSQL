/**
 * Turn a stream of MongoDB documents into a tabular ResultSet.
 *
 * Columns are the union of every document's TOP-LEVEL keys in first-seen order
 * (nested fields are flattened during introspection, never here). Each column's
 * kind is taken from the first non-null value seen for that key; each cell is
 * shaped value-first per the BSON fidelity rules in `bson.ts`.
 */

import type { CellValue, ColumnKind, ResultColumn } from '@asksql/core';
import { binaryToCell, bsonTag, jsonify } from './bson.js';

/** ColumnKind for a single value, driven by its runtime BSON shape. */
export function kindOfValue(value: unknown): ColumnKind {
  if (value === null || value === undefined) return 'unknown';
  if (value instanceof Date) return 'timestamp';
  if (Array.isArray(value)) return 'json';
  const t = typeof value;
  if (t === 'string') return 'text';
  if (t === 'boolean') return 'boolean';
  if (t === 'number') return 'number';
  if (t === 'bigint') return 'bigint';
  if (t === 'object') {
    switch (bsonTag(value)) {
      case 'ObjectId':
      case 'ObjectID':
        return 'text';
      case 'Long':
        return 'bigint';
      case 'Int32':
      case 'Double':
        return 'number';
      case 'Decimal128':
        return 'decimal';
      case 'Binary':
      case 'UUID':
        return 'binary';
      case undefined:
        return 'json';
      default:
        return 'unknown';
    }
  }
  return 'unknown';
}

/** Shape a single value into a JSON-safe cell (see the BSON fidelity rules). */
export function shapeValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'boolean') return value as boolean;
  if (t === 'number') return value as number;
  if (t === 'bigint') return String(value);
  if (Array.isArray(value)) return jsonify(value);
  if (t === 'object') {
    switch (bsonTag(value)) {
      case 'ObjectId':
      case 'ObjectID': {
        const v = value as { toHexString?: () => string };
        return typeof v.toHexString === 'function' ? v.toHexString() : String(value);
      }
      case 'Long':
      case 'Decimal128':
        return String(value);
      case 'Int32':
      case 'Double': {
        const n = Number((value as { valueOf(): unknown }).valueOf());
        return Number.isFinite(n) ? n : String(value);
      }
      case 'Binary':
      case 'UUID':
        return binaryToCell(value);
      default:
        return jsonify(value);
    }
  }
  return String(value);
}

/** Build the ResultSet column/row grid from returned documents. */
export function tabulate(docs: readonly Record<string, unknown>[]): {
  columns: ResultColumn[];
  rows: CellValue[][];
} {
  // Union of top-level keys, first-seen order.
  const order: string[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }

  const columns: ResultColumn[] = order.map((name) => {
    let kind: ColumnKind = 'unknown';
    for (const doc of docs) {
      const v = doc[name];
      if (v !== null && v !== undefined) {
        kind = kindOfValue(v);
        break;
      }
    }
    return { name, kind };
  });

  const rows: CellValue[][] = docs.map((doc) => order.map((name) => (name in doc ? shapeValue(doc[name]) : null)));

  return { columns, rows };
}
