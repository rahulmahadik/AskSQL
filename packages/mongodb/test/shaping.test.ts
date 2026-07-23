/**
 * BSON value classification + shaping (kindOfValue / shapeValue / tabulate).
 * Pure functions, keyed on `_bsontype`; covers every type branch.
 */
import { describe, expect, it } from 'vitest';
import { kindOfValue, shapeValue, tabulate } from '../src/rows.js';

const bson = (tag: string, extra: Record<string, unknown> = {}) => ({ _bsontype: tag, ...extra });

describe('kindOfValue', () => {
  const cases: [string, unknown, string][] = [
    ['null', null, 'unknown'],
    ['undefined', undefined, 'unknown'],
    ['Date', new Date(), 'timestamp'],
    ['array', [1, 2], 'json'],
    ['string', 'x', 'text'],
    ['boolean', true, 'boolean'],
    ['number', 1, 'number'],
    ['bigint', 1n, 'bigint'],
    ['ObjectId', bson('ObjectId'), 'text'],
    ['Long', bson('Long'), 'bigint'],
    ['Int32', bson('Int32'), 'number'],
    ['Double', bson('Double'), 'number'],
    ['Decimal128', bson('Decimal128'), 'decimal'],
    ['Binary', bson('Binary'), 'binary'],
    ['UUID', bson('UUID'), 'binary'],
    ['unknown bson', bson('Timestamp'), 'unknown'],
    ['plain object (subdocument)', {}, 'json'],
  ];
  for (const [name, val, expected] of cases) {
    it(`${name} -> ${expected}`, () => expect(kindOfValue(val)).toBe(expected));
  }
});

describe('shapeValue', () => {
  it('Date -> ISO string', () => expect(shapeValue(new Date('2024-01-02T03:04:05Z'))).toBe('2024-01-02T03:04:05.000Z'));
  it('bigint -> string', () => expect(shapeValue(10n)).toBe('10'));
  it('ObjectId -> hex via toHexString', () =>
    expect(shapeValue(bson('ObjectId', { toHexString: () => 'deadbeef' }))).toBe('deadbeef'));
  it('ObjectId without toHexString -> String()', () => expect(typeof shapeValue(bson('ObjectId'))).toBe('string'));
  it('Long -> string', () =>
    expect(shapeValue(bson('Long', { toString: () => '9223372036854775807' }))).toBe('9223372036854775807'));
  it('Decimal128 -> string', () => expect(shapeValue(bson('Decimal128', { toString: () => '1.50' }))).toBe('1.50'));
  it('Int32 -> finite number', () => expect(shapeValue(bson('Int32', { valueOf: () => 42 }))).toBe(42));
  it('Double non-finite -> string fallback', () =>
    expect(typeof shapeValue(bson('Double', { valueOf: () => Infinity, toString: () => 'Infinity' }))).toBe('string'));
  it('array -> jsonified', () => expect(shapeValue([1, 'a'])).toBeTruthy());
  it('unknown bson -> jsonified', () => expect(shapeValue(bson('Timestamp', { t: 1 }))).toBeTruthy());
  it('plain string/boolean/number pass through', () => {
    expect(shapeValue('hi')).toBe('hi');
    expect(shapeValue(false)).toBe(false);
    expect(shapeValue(3)).toBe(3);
  });
  it('null -> null', () => expect(shapeValue(null)).toBeNull());
});

describe('tabulate', () => {
  it('unions keys in first-seen order and infers each column kind from the first non-null value', () => {
    const { columns, rows } = tabulate([
      { _id: bson('ObjectId', { toHexString: () => 'a1' }), n: null },
      { n: 5, extra: 'x' },
    ]);
    expect(columns.map((c) => c.name)).toEqual(['_id', 'n', 'extra']);
    expect(columns.find((c) => c.name === 'n')!.kind).toBe('number'); // skips the leading null
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe('a1');
  });
  it('handles an empty document set', () => {
    const { columns, rows } = tabulate([]);
    expect(columns).toEqual([]);
    expect(rows).toEqual([]);
  });
});
