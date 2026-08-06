/**
 * Value-fidelity boundaries: BIGINT inside LIST/STRUCT containers (JSON.stringify refuses
 * bigint - the throw used to escape execute() as a raw TypeError), and non-finite doubles
 * (NaN/Infinity are not legal JSON and would serialize to null, aliasing SQL NULL).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDbConnector } from '../src/index.js';
import { shapeDuckValue } from '../src/shared.js';
import { AskSqlError } from '@asksql/core';

describe('shapeDuckValue containers and non-finite numbers', () => {
  it('an object holding bigint members stringifies instead of throwing', () => {
    const out = shapeDuckValue({ items: [1n, 9223372036854775807n] }, 'json');
    expect(typeof out).toBe('string');
    expect(out).toContain('9223372036854775807');
  });

  it('NaN and Infinity travel as strings, never as JSON null', () => {
    expect(shapeDuckValue(Number.NaN, 'number')).toBe('NaN');
    expect(shapeDuckValue(Number.POSITIVE_INFINITY, 'number')).toBe('Infinity');
    expect(shapeDuckValue(Number.NEGATIVE_INFINITY, 'number')).toBe('-Infinity');
    // A finite double is untouched.
    expect(shapeDuckValue(1.5, 'number')).toBe(1.5);
  });
});

describe('live engine: containers with 64-bit members', () => {
  let available = true;
  const conn = new DuckDbConnector({ id: 'duck-fid', name: 'Fidelity', files: [] });
  beforeAll(async () => {
    try {
      await conn.connect();
    } catch (err) {
      available = false;
      throw err; // an unavailable in-process engine is a broken install, not a skip
    }
  });
  afterAll(async () => {
    await conn.close();
  });

  it('SELECT of a BIGINT list does not escape execute() as a raw TypeError', async () => {
    if (!available) return;
    let result;
    try {
      result = await conn.execute('SELECT [1, 9223372036854775807]::BIGINT[] AS xs');
    } catch (err) {
      // If it fails, it must fail inside the taxonomy - never a naked TypeError.
      expect(AskSqlError.is(err), `raw ${String(err)} escaped execute()`).toBe(true);
      return;
    }
    const cell = result.rows[0]![0];
    expect(typeof cell).toBe('string');
    // The full 64-bit value survives, digit for digit.
    expect(cell).toContain('9223372036854775807');
    expect(() => JSON.stringify(result.rows)).not.toThrow();
  });

  it('SELECT of a STRUCT with a BIGINT member survives serialization', async () => {
    if (!available) return;
    const result = await conn.execute("SELECT {'id': 9223372036854775807::BIGINT} AS s");
    expect(() => JSON.stringify(result.rows)).not.toThrow();
    expect(String(result.rows[0]![0])).toContain('9223372036854775807');
  });

  it("SELECT 'nan'::DOUBLE serializes as the string 'NaN', not JSON null", async () => {
    if (!available) return;
    const result = await conn.execute("SELECT 'nan'::DOUBLE AS d, 'inf'::DOUBLE AS i");
    expect(result.rows[0]![0]).toBe('NaN');
    expect(result.rows[0]![1]).toBe('Infinity');
  });
});
