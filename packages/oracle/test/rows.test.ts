import { describe, expect, it } from 'vitest';
import { columnsFromMeta, shapeValue } from '../src/rows.js';

describe('columnsFromMeta', () => {
  it('maps Oracle types to column kinds, including parameterized TIMESTAMP', () => {
    const cols = columnsFromMeta([
      { name: 'ID', dbTypeName: 'NUMBER' },
      { name: 'NAME', dbTypeName: 'VARCHAR2' },
      { name: 'CREATED', dbTypeName: 'TIMESTAMP(6) WITH TIME ZONE' },
      { name: 'DATA', dbTypeName: 'RAW' },
    ]);
    expect(cols.map((c) => c.kind)).toEqual(['decimal', 'text', 'timestamp', 'binary']);
  });
});

describe('shapeValue', () => {
  it('keeps NUMBER as a string so precision is never lost', () => {
    expect(shapeValue('123456789012345678', 'decimal')).toBe('123456789012345678');
    expect(shapeValue(42, 'bigint')).toBe('42');
  });
  it('renders a Date as an ISO instant and null as null', () => {
    expect(shapeValue(new Date('2020-01-02T03:04:05Z'), 'timestamp')).toBe('2020-01-02T03:04:05.000Z');
    expect(shapeValue(null, 'text')).toBeNull();
  });
  it('coerces Oracle boolean surrogates (1 / Y)', () => {
    expect(shapeValue(1, 'boolean')).toBe(true);
    expect(shapeValue('Y', 'boolean')).toBe(true);
    expect(shapeValue(0, 'boolean')).toBe(false);
  });
});

describe('shapeValue covers every kind + edge', () => {
  it('null/undefined -> null', () => {
    expect(shapeValue(null, 'text')).toBeNull();
    expect(shapeValue(undefined, 'number')).toBeNull();
  });
  it('Buffer -> binary cell, Date -> ISO', () => {
    expect(shapeValue(Buffer.from('ab'), 'binary')).toHaveProperty('__binary');
    expect(shapeValue(new Date('2024-01-01T00:00:00Z'), 'timestamp')).toBe('2024-01-01T00:00:00.000Z');
  });
  it('bigint/decimal keep string precision (and coerce non-strings)', () => {
    expect(shapeValue('9999999999999999999', 'bigint')).toBe('9999999999999999999');
    expect(shapeValue(5, 'decimal')).toBe('5');
  });
  it('json passes strings through and stringifies objects', () => {
    expect(shapeValue('{"a":1}', 'json')).toBe('{"a":1}');
    expect(shapeValue({ a: 1 }, 'json')).toBe('{"a":1}');
  });
  it('boolean handles real booleans and 1/0, Y/N surrogates', () => {
    expect(shapeValue(true, 'boolean')).toBe(true);
    expect(shapeValue(1, 'boolean')).toBe(true);
    expect(shapeValue('Y', 'boolean')).toBe(true);
    expect(shapeValue('N', 'boolean')).toBe(false);
    expect(shapeValue(0, 'boolean')).toBe(false);
  });
  it('number keeps numbers, coerces finite strings, falls back on non-finite', () => {
    expect(shapeValue(42, 'number')).toBe(42);
    expect(shapeValue('42', 'number')).toBe(42);
    expect(shapeValue('not-a-number', 'number')).toBe('not-a-number');
  });
  it('default kind stringifies objects and passes primitives', () => {
    expect(shapeValue({ x: 1 }, 'unknown')).toBe('{"x":1}');
    expect(shapeValue(7, 'unknown')).toBe(7);
    expect(shapeValue('s', 'unknown')).toBe('s');
  });
});
