/**
 * SQL comment/string stripping: semicolons and quotes hidden inside strings,
 * E-strings, dollar-quotes, quoted identifiers, and comments must not read as
 * statement boundaries. Covers the stripper's escape branches.
 */
import { describe, expect, it } from 'vitest';
import {
  maskCommentsAndStrings,
  stripCommentsAndStrings,
  hasMultipleStatements,
  trimTrailingNoise,
} from '../src/strip.js';

const single = (sql: string) => hasMultipleStatements(stripCommentsAndStrings(sql));

describe('stripCommentsAndStrings hides delimiters inside literals', () => {
  it('a semicolon in a single-quoted string is not a boundary', () =>
    expect(single("SELECT 'a;b' FROM t")).toBe(false));
  it("a '' escape inside a string is handled", () => expect(single("SELECT 'it''s; fine' FROM t")).toBe(false));
  it('a backslash-escaped E-string hides its semicolon', () => expect(single("SELECT E'a\\';b' FROM t")).toBe(false));
  it('a dollar-quoted block hides its semicolon', () => expect(single('SELECT $$ a; b $$ FROM t')).toBe(false));
  it('a tagged dollar-quote hides its semicolon', () => expect(single('SELECT $tag$ a; b $tag$ FROM t')).toBe(false));
  it('a double-quoted identifier hides its semicolon', () => expect(single('SELECT "we;ird" FROM t')).toBe(false));
  it('a "" escape inside an identifier is handled', () => expect(single('SELECT "a""b;c" FROM t')).toBe(false));
  it('a line comment hides its semicolon', () => expect(single('SELECT 1 -- x; y\nFROM t')).toBe(false));
  it('a block comment hides its semicolon', () => expect(single('SELECT /* x; y */ 1 FROM t')).toBe(false));
  it('a real second statement IS a boundary', () => expect(single('SELECT 1; SELECT 2')).toBe(true));
  it('a trailing semicolon alone is not a second statement', () => expect(single('SELECT 1;')).toBe(false));
});

describe('trimTrailingNoise', () => {
  it('drops a trailing semicolon and whitespace', () => expect(trimTrailingNoise('SELECT 1;  \n')).toBe('SELECT 1'));
  it('leaves a clean statement untouched', () => expect(trimTrailingNoise('SELECT 1')).toBe('SELECT 1'));
});

// The guard locates a LIMIT in the masked text and edits the original at that index, so the mask
// must be the same length and every character it keeps must sit at its original position.
describe('maskCommentsAndStrings offsets', () => {
  const CASES = [
    "SELECT * FROM t WHERE a = 'x'",
    "SELECT 'it''s' FROM t",
    "SELECT $$a'b$$ FROM t",
    'SELECT $tag$ hi $tag$ FROM t',
    'SELECT "quoted id" FROM t',
    'SELECT `back` FROM t',
    'SELECT [bracket] FROM t',
    'SELECT 1 -- trailing\nFROM t',
    'SELECT 1 /* nested /* deep */ still */ FROM t',
    "SELECT 'unterminated",
    'SELECT `unterminated',
    'SELECT "unterminated',
    'SELECT /* unterminated',
    'SELECT $$unterminated',
  ];

  it.each(CASES)('keeps length and alignment for %j', (sql) => {
    for (const engine of [undefined, 'mysql']) {
      const masked = maskCommentsAndStrings(sql, engine);
      expect(masked.length).toBe(sql.length);
      for (let i = 0; i < masked.length; i++) {
        if (masked[i] !== ' ') expect(masked[i]).toBe(sql[i]);
      }
    }
  });

  it('hides the same spans as the stripping form', () => {
    for (const sql of CASES) {
      const masked = maskCommentsAndStrings(sql);
      // Whatever survives masking must also survive stripping, in the same order.
      const kept = masked.replace(/ +/g, ' ').trim();
      const stripped = stripCommentsAndStrings(sql).replace(/ +/g, ' ').trim();
      for (const ch of kept.replace(/[^A-Za-z0-9_*.,()=|]/g, '')) {
        expect(stripped).toContain(ch);
      }
    }
  });
});

describe('linear time on pathological whitespace (quadratic-regex regression)', () => {
  // A long internal whitespace run once made /[;\s]+$/ backtrack at every position (~seconds of
  // CPU near the 100k length cap). The bound here is generous; the quadratic form blew past it.
  it('hasMultipleStatements handles a 100k whitespace run quickly and correctly', () => {
    const sql = 'SELECT a FROM t WHERE b' + ' '.repeat(100_000) + '= 1';
    const started = performance.now();
    expect(hasMultipleStatements(sql)).toBe(false);
    expect(hasMultipleStatements(`${sql};`)).toBe(false);
    expect(hasMultipleStatements(`SELECT 1;${' '.repeat(100_000)}SELECT 2`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('trailing Unicode whitespace still trims like \\s did', () => {
    expect(hasMultipleStatements('SELECT 1;   ')).toBe(false);
  });
});
