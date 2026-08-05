/** Gap-closing cases for cell formatting + CSV that the client suite doesn't hit. */
import { describe, expect, it } from 'vitest';
import { formatBytes, formatCell, toCsv } from '../src/format.js';
import type { CellValue, ResultColumn } from '@asksql/core';

describe('formatCell / formatBytes edges', () => {
  it('formats booleans and numbers as values', () => {
    expect(formatCell(true)).toMatchObject({ text: 'true', kind: 'value' });
    expect(formatCell(false).text).toBe('false');
    expect(formatCell(42).text).toBe('42');
  });

  it('scales byte counts to KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('truncates over-long strings with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const cell = formatCell(long);
    expect(cell.text.endsWith('…')).toBe(true);
    expect(cell.title).toBe(long);
  });
});

describe('toCsv injection + binary', () => {
  it('neutralizes formula-injection prefixes and serializes binary as hex', () => {
    const cols: ResultColumn[] = [
      { name: 'a', kind: 'text' },
      { name: 'b', kind: 'binary' },
    ];
    const rows: CellValue[][] = [['=SUM(A1)', { __binary: { bytes: 4, hexPreview: 'cafe' } }]];
    const csv = toCsv(cols, rows);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain('0xcafe');
  });

  it('exports negative numbers as numbers, including the strings BIGINT/DECIMAL arrive as', () => {
    const cols: ResultColumn[] = [
      { name: 'delta', kind: 'number' },
      { name: 'balance', kind: 'decimal' },
      { name: 'sci', kind: 'number' },
    ];
    const rows: CellValue[][] = [[-42, '-1234.50', -1.5e-7]];
    expect(toCsv(cols, rows).split('\n')[1]).toBe('-42,-1234.50,-1.5e-7');
  });

  it('still neutralizes a formula that opens with a number-like prefix', () => {
    const cols: ResultColumn[] = [{ name: 'a', kind: 'text' }];
    const csv = toCsv(cols, [["-5+cmd|' /C calc'!A0"]]);
    expect(csv).toContain("'-5+cmd");
  });
});
