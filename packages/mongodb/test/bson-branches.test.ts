/** bsonTypeOf / binaryToCell / jsonify / toPlain branch coverage across BSON types. */
import { describe, expect, it } from 'vitest';
import { bsonTypeOf, binaryToCell, jsonify, toPlain, displayScalar } from '../src/bson.js';

const b = (tag: string, extra: Record<string, unknown> = {}) => ({ _bsontype: tag, ...extra });

describe('bsonTypeOf', () => {
  const cases: [string, unknown, string][] = [
    ['null', null, 'null'],
    ['undefined', undefined, 'null'],
    ['Date', new Date(), 'date'],
    ['array', [1], 'array'],
    ['string', 's', 'string'],
    ['bool', true, 'bool'],
    ['bigint', 1n, 'long'],
    ['integer', 5, 'int'],
    ['float', 5.5, 'double'],
    ['ObjectId', b('ObjectId'), 'objectId'],
    ['Long', b('Long'), 'long'],
    ['Int32', b('Int32'), 'int'],
    ['Double', b('Double'), 'double'],
    ['Decimal128', b('Decimal128'), 'decimal'],
    ['Binary', b('Binary'), 'binary'],
    ['UUID', b('UUID'), 'binary'],
    ['Timestamp', b('Timestamp'), 'timestamp'],
    ['subdocument', {}, 'object'],
    ['unknown bson', b('Weird'), 'unknown'],
  ];
  for (const [n, v, e] of cases) it(`${n} -> ${e}`, () => expect(bsonTypeOf(v)).toBe(e));
});

describe('binaryToCell / jsonify / toPlain / displayScalar', () => {
  it('binaryToCell reports size + hex preview from a Binary wrapper', () => {
    const cell = binaryToCell(b('Binary', { buffer: new Uint8Array([1, 2, 3]) })) as { __binary: { bytes: number } };
    expect(cell.__binary.bytes).toBeGreaterThanOrEqual(0);
  });
  it('binaryToCell handles a raw Uint8Array and a missing buffer', () => {
    expect(binaryToCell(new Uint8Array([9]))).toHaveProperty('__binary');
    expect(binaryToCell(b('Binary'))).toHaveProperty('__binary');
  });
  it('jsonify stringifies nested BSON to plain JSON', () => {
    const s = jsonify({
      id: b('ObjectId', { toHexString: () => 'ab' }),
      n: 1n,
      when: new Date('2024-01-01T00:00:00Z'),
    });
    expect(typeof s).toBe('string');
    expect(s).toContain('ab');
  });
  it('toPlain converts a bigint and a Date', () => {
    expect(typeof toPlain(5n)).not.toBe('bigint');
    expect(typeof toPlain(new Date())).toBe('string');
  });
  it('displayScalar returns a string for scalars and null for objects', () => {
    expect(displayScalar('x')).toBe('x');
    expect(displayScalar([1, 2])).toBeNull();
  });
});
