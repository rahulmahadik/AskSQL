import { describe, expect, it } from 'vitest';
import { kindOfValue, shapeValue, tabulate } from '../src/rows.js';

describe('tabulate', () => {
  it('unions top-level keys in first-seen order and null-fills missing fields', () => {
    const { columns, rows } = tabulate([
      { a: 1, b: 'x' },
      { a: 2, c: true },
    ]);
    expect(columns.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      [1, 'x', null],
      [2, null, true],
    ]);
  });

  it('takes a column kind from the first non-null value', () => {
    const { columns } = tabulate([{ n: null }, { n: 5 }]);
    expect(columns[0]!.kind).toBe('number');
  });

  it('does not flatten a nested object; it becomes one JSON column', () => {
    const { columns, rows } = tabulate([{ meta: { city: 'NYC' } }]);
    expect(columns[0]!.kind).toBe('json');
    expect(typeof rows[0]![0]).toBe('string');
    expect(rows[0]![0]).toContain('NYC');
  });
});

describe('kindOfValue / shapeValue', () => {
  it('classifies primitives', () => {
    expect(kindOfValue('x')).toBe('text');
    expect(kindOfValue(3.5)).toBe('number');
    expect(kindOfValue(true)).toBe('boolean');
  });
  it('passes primitives through unchanged', () => {
    expect(shapeValue('x')).toBe('x');
    expect(shapeValue(7)).toBe(7);
    expect(shapeValue(null)).toBeNull();
  });
});
