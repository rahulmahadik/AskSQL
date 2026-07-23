/**
 * BSON value handling shared by introspection and result shaping.
 *
 * Documents returned by the driver carry BSON wrapper instances (ObjectId,
 * Long, Decimal128, Binary, ...) identified by a `_bsontype` tag. These helpers
 * classify a value and render it JSON-safely, applying the numeric fidelity
 * rule: Long and Decimal128 travel as strings so a JS `number` never touches
 * them; binary is a size + hex preview.
 */

import type { CellValue } from '@asksql/core';

/** First N bytes of binary rendered as a hex preview. */
export const HEX_PREVIEW_BYTES = 32;

interface Bsonish {
  readonly _bsontype?: string;
  readonly [key: string]: unknown;
}

/** The BSON discriminator tag, or undefined for plain objects / non-objects. */
export function bsonTag(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Bsonish)._bsontype;
}

/**
 * The inferred BSON type name of a sampled value:
 * string / int / long / double / decimal / bool / objectId / date / binary /
 * object / array. Plain JS numbers are split by integrality (best effort under
 * value promotion); wrapper types are read from `_bsontype`.
 */
export function bsonTypeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'bool';
  if (t === 'bigint') return 'long';
  if (t === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (t === 'object') {
    switch (bsonTag(value)) {
      case 'ObjectId':
      case 'ObjectID':
        return 'objectId';
      case 'Long':
        return 'long';
      case 'Int32':
        return 'int';
      case 'Double':
        return 'double';
      case 'Decimal128':
        return 'decimal';
      case 'Binary':
      case 'UUID':
        return 'binary';
      case 'Timestamp':
        return 'timestamp';
      case undefined:
        return 'object';
      default:
        return 'unknown';
    }
  }
  return 'unknown';
}

function objectIdHex(value: unknown): string {
  const v = value as { toHexString?: () => string };
  return typeof v.toHexString === 'function' ? v.toHexString() : String(value);
}

function binaryBuffer(value: unknown): Uint8Array {
  const v = value as { buffer?: Uint8Array };
  if (v.buffer instanceof Uint8Array) return v.buffer;
  if (value instanceof Uint8Array) return value;
  return new Uint8Array();
}

function binaryHex(value: unknown, max: number): string {
  const buf = binaryBuffer(value);
  return Buffer.from(buf.subarray(0, max)).toString('hex');
}

/** Binary -> a size + hex preview cell (first {@link HEX_PREVIEW_BYTES} bytes). */
export function binaryToCell(value: unknown): CellValue {
  const buf = binaryBuffer(value);
  return { __binary: { bytes: buf.length, hexPreview: binaryHex(value, HEX_PREVIEW_BYTES) } };
}

/**
 * A short display string for a scalar value, used as a schema example. Returns
 * null for object / array / binary values, which are not collected as examples.
 */
export function displayScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'boolean') return String(value);
  if (t === 'bigint') return String(value);
  if (t === 'number') return String(value);
  if (t === 'object') {
    switch (bsonTag(value)) {
      case 'ObjectId':
      case 'ObjectID':
        return objectIdHex(value);
      case 'Long':
      case 'Decimal128':
      case 'Int32':
      case 'Double':
      case 'Timestamp':
        return String(value);
      default:
        return null;
    }
  }
  return null;
}

/**
 * Convert a value into a plain JSON-safe structure, recursively: ObjectId ->
 * hex, Long / Decimal128 -> string, Date -> ISO, Binary -> `0x...`, nested
 * documents / arrays descended into. Used to render an object / array cell as a
 * JSON string that a UI can parse without knowing about BSON.
 */
export function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toPlain);
  const t = typeof value;
  if (t === 'bigint') return String(value);
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'object') {
    const tag = bsonTag(value);
    if (tag) {
      switch (tag) {
        case 'ObjectId':
        case 'ObjectID':
          return objectIdHex(value);
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
          return `0x${binaryHex(value, HEX_PREVIEW_BYTES)}`;
        default:
          return String(value);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toPlain(v);
    return out;
  }
  return String(value);
}

/** Stringify a value as plain JSON (BSON wrappers flattened via {@link toPlain}). */
export function jsonify(value: unknown): string {
  return JSON.stringify(toPlain(value));
}
