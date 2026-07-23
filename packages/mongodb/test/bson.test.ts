/**
 * BSON value handling: type inference, display, and JSON-safe rendering with the
 * numeric-fidelity rule (Long/Decimal128 -> string, never a JS number). Uses
 * lightweight stand-ins for the driver's BSON wrappers, identified by _bsontype.
 */
import { describe, expect, it } from 'vitest';
import { bsonTypeOf, binaryToCell, displayScalar, toPlain, jsonify } from '../src/bson.js';

const objectId = (hex: string) => ({ _bsontype: 'ObjectId', toHexString: () => hex, toString: () => hex });
const long = (s: string) => ({ _bsontype: 'Long', toString: () => s });
const decimal = (s: string) => ({ _bsontype: 'Decimal128', toString: () => s });
const int32 = (n: number) => ({ _bsontype: 'Int32', valueOf: () => n, toString: () => String(n) });
const dbl = (n: number) => ({ _bsontype: 'Double', valueOf: () => n, toString: () => String(n) });
const binary = (bytes: number[]) => ({ _bsontype: 'Binary', buffer: new Uint8Array(bytes) });
const timestamp = (s: string) => ({ _bsontype: 'Timestamp', toString: () => s });

describe('bsonTypeOf', () => {
  it('classifies primitives and JS numbers by integrality', () => {
    expect(bsonTypeOf('x')).toBe('string');
    expect(bsonTypeOf(true)).toBe('bool');
    expect(bsonTypeOf(3)).toBe('int');
    expect(bsonTypeOf(3.5)).toBe('double');
    expect(bsonTypeOf(9007199254740993n)).toBe('long');
    expect(bsonTypeOf(new Date())).toBe('date');
    expect(bsonTypeOf([1, 2])).toBe('array');
    expect(bsonTypeOf(null)).toBe('null');
    expect(bsonTypeOf(undefined)).toBe('null');
  });

  it('reads BSON wrapper tags', () => {
    expect(bsonTypeOf(objectId('a'))).toBe('objectId');
    expect(bsonTypeOf(long('1'))).toBe('long');
    expect(bsonTypeOf(int32(1))).toBe('int');
    expect(bsonTypeOf(dbl(1.5))).toBe('double');
    expect(bsonTypeOf(decimal('1.1'))).toBe('decimal');
    expect(bsonTypeOf(binary([1]))).toBe('binary');
    expect(bsonTypeOf({ _bsontype: 'UUID', buffer: new Uint8Array() })).toBe('binary');
    expect(bsonTypeOf(timestamp('t'))).toBe('timestamp');
    expect(bsonTypeOf({ a: 1 })).toBe('object'); // plain object, no tag
    expect(bsonTypeOf({ _bsontype: 'Code' })).toBe('unknown'); // unhandled wrapper
  });
});

describe('displayScalar (schema examples)', () => {
  it('renders scalars and returns null for non-scalars', () => {
    expect(displayScalar('hi')).toBe('hi');
    expect(displayScalar(false)).toBe('false');
    expect(displayScalar(42)).toBe('42');
    expect(displayScalar(9n)).toBe('9');
    expect(displayScalar(objectId('deadbeef'))).toBe('deadbeef');
    expect(displayScalar(long('123'))).toBe('123');
    expect(displayScalar(decimal('9.99'))).toBe('9.99');
    const d = new Date('2021-06-01T00:00:00Z');
    expect(displayScalar(d)).toBe('2021-06-01T00:00:00.000Z');
    expect(displayScalar(null)).toBeNull();
    expect(displayScalar(binary([1, 2]))).toBeNull();
    expect(displayScalar([1])).toBeNull();
  });
});

describe('toPlain / jsonify (JSON-safe rendering, fidelity preserved)', () => {
  it('flattens BSON wrappers with Long/Decimal128 as strings', () => {
    expect(toPlain(objectId('abc'))).toBe('abc');
    expect(toPlain(long('9007199254740993'))).toBe('9007199254740993'); // string, not lossy number
    expect(toPlain(decimal('3.14159265358979'))).toBe('3.14159265358979');
    expect(toPlain(int32(7))).toBe(7);
    expect(toPlain(dbl(2.5))).toBe(2.5);
    expect(toPlain(9n)).toBe('9');
    expect(toPlain(new Date('2020-01-01T00:00:00Z'))).toBe('2020-01-01T00:00:00.000Z');
    expect(toPlain(binary([0xde, 0xad]))).toBe('0xdead');
  });

  it('descends recursively into nested documents and arrays', () => {
    const doc = {
      id: objectId('a1'),
      tags: ['x', long('5')],
      meta: { n: int32(3), when: new Date('2020-01-01T00:00:00Z') },
    };
    expect(toPlain(doc)).toEqual({ id: 'a1', tags: ['x', '5'], meta: { n: 3, when: '2020-01-01T00:00:00.000Z' } });
  });

  it('jsonify produces a parseable JSON string', () => {
    const s = jsonify({ id: objectId('ff'), big: long('10000000000000001') });
    expect(JSON.parse(s)).toEqual({ id: 'ff', big: '10000000000000001' });
  });
});

describe('binaryToCell', () => {
  it('renders a size + hex preview, capped', () => {
    const cell = binaryToCell(binary([1, 2, 255])) as { __binary: { bytes: number; hexPreview: string } };
    expect(cell.__binary.bytes).toBe(3);
    expect(cell.__binary.hexPreview).toBe('0102ff');
  });
  it('caps the preview at HEX_PREVIEW_BYTES', () => {
    const big = binaryToCell(binary(Array.from({ length: 100 }, () => 0xab))) as {
      __binary: { bytes: number; hexPreview: string };
    };
    expect(big.__binary.bytes).toBe(100);
    expect(big.__binary.hexPreview.length).toBe(32 * 2); // 32 bytes -> 64 hex chars
  });
});
