/**
 * Row-shaping: column classification from pg type OIDs (with a name-based
 * fallback) and cell shaping (numeric fidelity, bytea preview, json, boolean).
 */

import { describe, expect, it } from 'vitest';
import { bufferToCell, columnsFromFields, shapeValue } from '../src/rows.js';

describe('columnsFromFields', () => {
  it('classifies known OIDs and carries the resolved type name', () => {
    const typeName = (oid: number): string => ({ 20: 'int8', 1700: 'numeric', 25: 'text' })[oid] ?? `oid_${oid}`;
    const cols = columnsFromFields(
      [
        { name: 'big', dataTypeID: 20 },
        { name: 'amt', dataTypeID: 1700 },
        { name: 'flag', dataTypeID: 16 },
        { name: 'doc', dataTypeID: 3802 },
        { name: 'raw', dataTypeID: 17 },
        { name: 'ts', dataTypeID: 1184 },
      ],
      typeName,
    );
    expect(cols.map((c) => c.kind)).toEqual(['bigint', 'decimal', 'boolean', 'json', 'binary', 'timestamp']);
    expect(cols[0]).toEqual({ name: 'big', dbType: 'int8', kind: 'bigint' });
  });

  it('falls back to name-based classification for an unknown OID', () => {
    const cols = columnsFromFields([{ name: 'x', dataTypeID: 99999 }], () => 'text');
    expect(cols[0]!.kind).toBe('text');
  });
});

describe('shapeValue', () => {
  it('keeps bigint / numeric as strings for fidelity', () => {
    expect(shapeValue('9007199254740993', 'bigint')).toBe('9007199254740993');
    expect(shapeValue(12, 'decimal')).toBe('12');
  });
  it('renders a bytea buffer as a size + hex preview', () => {
    expect(shapeValue(Buffer.from('hello'), 'binary')).toEqual({ __binary: { bytes: 5, hexPreview: '68656c6c6f' } });
    expect(bufferToCell(Buffer.from('AB'))).toEqual({ __binary: { bytes: 2, hexPreview: '4142' } });
  });
  it('renders a Date as an ISO instant regardless of kind', () => {
    expect(shapeValue(new Date('2020-01-02T03:04:05Z'), 'date')).toBe('2020-01-02T03:04:05.000Z');
  });
  it('handles json as string-or-stringified, and coerces boolean surrogates', () => {
    expect(shapeValue('{"a":1}', 'json')).toBe('{"a":1}');
    expect(shapeValue({ a: 1 }, 'json')).toBe('{"a":1}');
    expect(shapeValue('t', 'boolean')).toBe(true);
    expect(shapeValue('false', 'boolean')).toBe(false);
    expect(shapeValue(true, 'boolean')).toBe(true);
  });
  it('coerces numbers and falls through for text-ish defaults', () => {
    expect(shapeValue('42', 'number')).toBe(42);
    expect(shapeValue(3.5, 'number')).toBe(3.5);
    expect(shapeValue('not-a-number', 'number')).toBe('not-a-number');
    expect(shapeValue({ nested: true }, 'text')).toBe('{"nested":true}');
    expect(shapeValue('plain', 'text')).toBe('plain');
    expect(shapeValue(null, 'text')).toBeNull();
  });
});
