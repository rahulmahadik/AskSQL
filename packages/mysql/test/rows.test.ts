/**
 * Row-shaping: column classification from the mysql2 protocol type code (with a
 * value-sample fallback) and cell shaping (bigint/decimal fidelity, binary
 * preview, dates, JSON).
 */

import { describe, expect, it } from 'vitest';
import { columnsFromFields, shapeMysqlValue } from '../src/rows.js';

describe('columnsFromFields', () => {
  it('classifies from the driver column type code', () => {
    const cols = columnsFromFields(
      [
        { name: 'big', columnType: 8 }, // LONGLONG
        { name: 'dec', columnType: 246 }, // NEWDECIMAL
        { name: 'n', columnType: 3 }, // LONG
        { name: 'ts', columnType: 12 }, // DATETIME
        { name: 'd', columnType: 10 }, // DATE
        { name: 'j', columnType: 245 }, // JSON
        { name: 'blob', columnType: 252 }, // BLOB
        { name: 'txt', columnType: 253 }, // VAR_STRING
      ],
      [],
    );
    expect(cols.map((c) => c.kind)).toEqual([
      'bigint',
      'decimal',
      'number',
      'timestamp',
      'date',
      'json',
      'binary',
      'text',
    ]);
  });

  it('falls back to `type` then to a value sample when the type code is unknown', () => {
    const cols = columnsFromFields(
      [
        { name: 'a', type: 8 }, // no columnType -> use type
        { name: 'unknown_code', columnType: 9999 }, // unknown -> sample the row
      ],
      [[null, 12345678901234567890n]],
    );
    expect(cols[0]!.kind).toBe('bigint');
    expect(cols[1]!.kind).toBe('bigint');
  });

  it('infers kinds from sampled values when no type code is present', () => {
    const kind = (sample: unknown): string => columnsFromFields([{ name: 'c' }], [[sample]])[0]!.kind;
    expect(kind(42n)).toBe('bigint');
    expect(kind(3.14)).toBe('number');
    expect(kind(true)).toBe('boolean');
    expect(kind(Buffer.from('x'))).toBe('binary');
    expect(kind(new Date())).toBe('timestamp');
    expect(kind({ a: 1 })).toBe('json');
    expect(kind('12345678901234567')).toBe('bigint'); // 16+ digit string
    expect(kind('3.14')).toBe('decimal');
    expect(kind('hello')).toBe('text');
  });

  it('reports unknown when a column is entirely null and untyped', () => {
    const cols = columnsFromFields([{ name: 'c' }], [[null], [null]]);
    expect(cols[0]!.kind).toBe('unknown');
  });
});

describe('shapeMysqlValue', () => {
  it('keeps bigint fidelity as a string', () => {
    expect(shapeMysqlValue(9007199254740993n)).toBe('9007199254740993');
  });
  it('renders a buffer as a size + hex preview', () => {
    expect(shapeMysqlValue(Buffer.from('hello'))).toEqual({
      __binary: { bytes: 5, hexPreview: '68656c6c6f' },
    });
  });
  it('renders a Date as an ISO instant', () => {
    expect(shapeMysqlValue(new Date('2020-01-02T03:04:05Z'))).toBe('2020-01-02T03:04:05.000Z');
  });
  it('re-stringifies JSON objects and passes numbers/booleans through', () => {
    expect(shapeMysqlValue({ a: 1 })).toBe('{"a":1}');
    expect(shapeMysqlValue(7)).toBe(7);
    expect(shapeMysqlValue(false)).toBe(false);
  });
  it('maps null/undefined to null and coerces other scalars to strings', () => {
    expect(shapeMysqlValue(null)).toBeNull();
    expect(shapeMysqlValue(undefined)).toBeNull();
    expect(shapeMysqlValue('abc')).toBe('abc');
  });
});
