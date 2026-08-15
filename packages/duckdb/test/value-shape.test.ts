/**
 * DuckDB's node driver wraps every type without a plain JavaScript equivalent. Serializing a wrapper
 * exposes its storage rather than its value, so a date arrives as `{"days":19787}` and a list as
 * `{"items":[1,2,3]}` - wrong, with nothing to raise. The wrappers are reproduced here rather than
 * imported, because shapeDuckValue is shared with DuckDB-WASM and must handle both.
 */
import { describe, expect, it } from 'vitest';
import { classifyDuckType, shapeDuckValue } from '../src/shared.js';

/**
 * A node-api wrapper: own storage fields, a toString that yields the value, and - crucially - a
 * prototype of its own. A plain object literal is DATA, and shaping treats the two differently.
 */
const wrapper = <T extends object>(fields: T, text: string): T =>
  Object.assign(Object.create({ toString: () => text }) as T, fields);

describe('shapeDuckValue', () => {
  it('renders temporal wrappers as their value, not their storage', () => {
    expect(shapeDuckValue(wrapper({ days: 19787 }, '2024-03-05'), 'date')).toBe('2024-03-05');
    expect(shapeDuckValue(wrapper({ micros: 1709649000000000n }, '2024-03-05 14:30:00'), 'timestamp')).toBe(
      '2024-03-05 14:30:00',
    );
    expect(shapeDuckValue(wrapper({ micros: 86399000000n }, '23:59:59'), 'unknown')).toBe('23:59:59');
    expect(shapeDuckValue(wrapper({ months: 0, days: 1, micros: 0n }, '1 day'), 'unknown')).toBe('1 day');
  });

  it('renders a uuid as its text rather than its hugeint', () => {
    const uuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    expect(shapeDuckValue(wrapper({ hugeint: 43774887780656280754024793008116337169n }, uuid), 'text')).toBe(uuid);
  });

  it('unwraps list, struct and map so the cell stays JSON', () => {
    expect(shapeDuckValue(wrapper({ items: [1, 2, 3] }, '[1, 2, 3]'), 'json')).toBe('[1,2,3]');
    expect(shapeDuckValue(wrapper({ entries: { a: 1 } }, "{'a': 1}"), 'json')).toBe('{"a":1}');
    expect(shapeDuckValue(wrapper({ entries: [{ key: 'a', value: 1 }] }, "{'a': 1}"), 'json')).toBe(
      '[{"key":"a","value":1}]',
    );
  });

  it('gives a blob the same preview shape as every other adapter', () => {
    const blob = wrapper({ bytes: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]) }, 'Hello');
    expect(shapeDuckValue(blob, 'binary')).toEqual({ __binary: { bytes: 5, hexPreview: '48656c6c6f' } });
  });

  it('leaves a bigint member serializable rather than throwing', () => {
    // JSON.stringify refuses a bigint, and the throw would escape execute() as a raw TypeError.
    expect(() => shapeDuckValue(wrapper({ items: [1n, 2n] }, '[1, 2]'), 'json')).not.toThrow();
    expect(shapeDuckValue(wrapper({ items: [1n, 2n] }, '[1, 2]'), 'json')).toBe('["1","2"]');
  });

  it('nests: a date inside a list and a blob inside a struct are shaped like one at the top level', () => {
    // The wrappers nest, so unwrapping one level left {"days":19787} inside a list and expanded a
    // nested blob byte-by-byte - a 100KB blob became a 300,000-character cell.
    const date = wrapper({ days: 19787 }, '2024-03-05');
    expect(shapeDuckValue(wrapper({ items: [date, date] }, '[…]'), 'json')).toBe('["2024-03-05","2024-03-05"]');
    const blob = wrapper({ bytes: new Uint8Array([0x68, 0x69]) }, 'hi');
    expect(shapeDuckValue(wrapper({ entries: { b: blob, n: 1 } }, '{…}'), 'json')).toBe(
      '{"b":{"__binary":{"bytes":2,"hexPreview":"6869"}},"n":1}',
    );
  });

  it('uses Arrow toJSON for DuckDB-WASM values, whatever their fields are called', () => {
    // Arrow defines a real toString, so it cannot be the discriminator: every WASM composite took
    // the wrapper branch, and a struct with a field named `items` collapsed to just that member.
    const arrowStruct = { items: 5, n: 1, toJSON: () => ({ items: 5, n: 1 }), toString: () => '{"items": 5, "n": 1}' };
    expect(shapeDuckValue(arrowStruct, 'json')).toBe('{"items":5,"n":1}');
    // Arrow's toString drops nulls and quoting; toJSON keeps both.
    const arrowList = { toJSON: () => [1, null, 3], toString: () => '[1,,3]' };
    expect(shapeDuckValue(arrowList, 'json')).toBe('[1,null,3]');
    const withComma = { toJSON: () => ['a', 'b,c'], toString: () => '[a,b,c]' };
    expect(shapeDuckValue(withComma, 'json')).toBe('["a","b,c"]');
  });

  it('still serializes a plain object with no wrapper markers', () => {
    expect(shapeDuckValue({ a: 1 }, 'json')).toBe('{"a":1}');
  });

  it('keeps the values that already worked', () => {
    expect(shapeDuckValue(null, 'text')).toBeNull();
    expect(shapeDuckValue(9007199254740993n, 'bigint')).toBe('9007199254740993');
    expect(shapeDuckValue(new Date('2024-03-05T00:00:00Z'), 'timestamp')).toBe('2024-03-05T00:00:00.000Z');
    expect(shapeDuckValue(new Uint8Array([1, 2]), 'binary')).toEqual({
      __binary: { bytes: 2, hexPreview: '0102' },
    });
    expect(shapeDuckValue(42, 'number')).toBe(42);
    expect(shapeDuckValue(Number.NaN, 'number')).toBe('NaN');
    expect(shapeDuckValue(true, 'boolean')).toBe(true);
    expect(shapeDuckValue('plain', 'text')).toBe('plain');
  });
});

describe('classifyDuckType', () => {
  it('reads a composite type by its shape, not by its member type', () => {
    // Each of these contains "integer" or "varchar"; calling one a number offers it as a chart measure.
    expect(classifyDuckType('INTEGER[]')).toBe('json');
    expect(classifyDuckType('STRUCT("a" INTEGER)')).toBe('json');
    expect(classifyDuckType('MAP(VARCHAR, INTEGER)')).toBe('json');
    expect(classifyDuckType('STRUCT("a" VARCHAR)')).toBe('json');
    expect(classifyDuckType('DECIMAL(30,5)[]')).toBe('json');
  });

  it('still classifies the scalar types it always did', () => {
    expect(classifyDuckType('BIGINT')).toBe('bigint');
    expect(classifyDuckType('Int64')).toBe('bigint');
    expect(classifyDuckType('HUGEINT')).toBe('bigint');
    expect(classifyDuckType('DECIMAL(30,5)')).toBe('decimal');
    expect(classifyDuckType('INTEGER')).toBe('number');
    expect(classifyDuckType('DOUBLE')).toBe('number');
    expect(classifyDuckType('TIMESTAMP WITH TIME ZONE')).toBe('timestamp');
    expect(classifyDuckType('DATE')).toBe('date');
    expect(classifyDuckType('VARCHAR')).toBe('text');
    expect(classifyDuckType('UUID')).toBe('text');
    expect(classifyDuckType('BLOB')).toBe('binary');
    expect(classifyDuckType('BOOLEAN')).toBe('boolean');
    expect(classifyDuckType(undefined)).toBe('unknown');
  });
});
