/**
 * SQL comment/string stripping: semicolons and quotes hidden inside strings,
 * E-strings, dollar-quotes, quoted identifiers, and comments must not read as
 * statement boundaries. Covers the stripper's escape branches.
 */
import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings, hasMultipleStatements, trimTrailingNoise } from '../src/strip.js';

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
