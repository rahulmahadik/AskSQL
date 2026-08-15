/**
 * Identifiers a database would not read back as itself: a name spelled in the wrong case, a
 * mixed-case name left unquoted on an engine that folds, a reserved word, a symbol. MySQL on Linux
 * compares table names case-sensitively; Postgres folds unquoted names down and Oracle folds up.
 * Quoting from the catalog covers all of it, and the catalog can repair it without a model call.
 */

import { reservedWordsFor } from './sql-keywords.js';

// The union across engines: treating a word as syntax is the conservative side of this decision.
const ANY_RESERVED = reservedWordsFor('*');

/** Only these lead-ins put an identifier in table position, which keeps a same-named column alone. */
const TABLE_POSITION =
  /\b(from|join|update|into)(\s+)([`"[]?)([A-Za-z_][\w$]*)[`"\]]?(\s*\.\s*([`"[]?)([A-Za-z_][\w$]*)[`"\]]?)?/gi;

const CLOSING: Record<string, string> = { '`': '`', '"': '"', '[': ']' };

function quoted(name: string, quoteChar: string): string {
  return `${quoteChar}${name}${CLOSING[quoteChar] ?? quoteChar}`;
}

/** Where a literal or comment ends, so identifiers are never rewritten inside one. */
function skipTo(sql: string, i: number, doubleQuoteIsLiteral: boolean, backslashEscapes = false): number {
  const ch = sql[i];
  const next = sql[i + 1];
  // $$body$$ and $tag$body$tag$ are literals in Postgres and DuckDB, and may contain anything.
  if (ch === '$') {
    const open = /^\$[A-Za-z_][\w]*\$|^\$\$/.exec(sql.slice(i));
    if (open) {
      const close = sql.indexOf(open[0], i + open[0].length);
      return close === -1 ? sql.length : close + open[0].length;
    }
  }
  if (ch === '-' && next === '-') {
    const nl = sql.indexOf('\n', i);
    return nl === -1 ? sql.length : nl;
  }
  if (ch === '/' && next === '*') {
    const close = sql.indexOf('*/', i + 2);
    return close === -1 ? sql.length : close + 2;
  }
  if (ch === "'" || (ch === '"' && doubleQuoteIsLiteral)) {
    // E'a\'b' is one literal on Postgres and DuckDB: the backslash escapes the quote whatever the
    // dialect's default is. Reading it as two literals hands the middle to the rewriter as code.
    const escaped = backslashEscapes || /\bE$/i.test(sql.slice(Math.max(0, i - 2), i));
    let j = i + 1;
    while (j < sql.length) {
      if (escaped && sql[j] === '\\') j += 2;
      else if (sql[j] === ch) {
        // A doubled quote is an escaped one, so the literal continues past it.
        if (sql[j + 1] === ch) j += 2;
        else return j + 1;
      } else j++;
    }
    return sql.length;
  }
  return -1;
}

/** How an engine resolves an unquoted identifier: Postgres lower-cases it, Oracle upper-cases it. */
export type Folding = 'lower' | 'upper' | 'none';

export function foldingFor(engine: string): Folding {
  if (engine === 'postgres') return 'lower';
  if (engine === 'oracle') return 'upper';
  return 'none';
}

function folded(name: string, folding: Folding): string {
  if (folding === 'lower') return name.toLowerCase();
  if (folding === 'upper') return name.toUpperCase();
  return name;
}

/**
 * Rewrites table references the database will not resolve to the catalog's table. That covers a name
 * spelled in the wrong case, and on a folding engine a mixed-case name left unquoted, which resolves
 * to something else entirely. Returns null when nothing changes.
 */
export function correctTableCase(
  sql: string,
  tableNames: readonly string[],
  quoteChar: string,
  folding: Folding = 'none',
): string | null {
  const byLower = new Map<string, string>();
  for (const name of tableNames) {
    const lower = name.toLowerCase();
    // An ambiguous fold has no single right answer, so leave those names untouched.
    if (byLower.has(lower) && byLower.get(lower) !== name) byLower.set(lower, '');
    else if (!byLower.has(lower)) byLower.set(lower, name);
  }

  let changed = false;
  const fixCode = (code: string): string =>
    code.replace(
      TABLE_POSITION,
      (
        whole: string,
        keyword: string,
        gap: string,
        open: string,
        first: string,
        qualified: string | undefined,
        _open2: string | undefined,
        second: string | undefined,
        offset: number,
      ) => {
        const target = second ?? first;
        const canonical = byLower.get(target.toLowerCase());
        if (!canonical) return whole;
        // A third part means what matched is a qualifier: prod.sales.orders names orders, not sales.
        // `offset` is relative to this chunk, so indexing the whole statement reads an earlier
        // position once any literal or comment has split it, and the guard silently stops firing.
        if (/^\s*\./.test(code.slice(offset + whole.length))) return whole;
        // An unquoted name is resolved folded, so what matters is what the database will look up.
        const wasQuoted = (second === undefined ? open : (_open2 ?? '')) !== '';
        const resolvesTo = wasQuoted ? target : folded(target, folding);
        if (resolvesTo === canonical) return whole;
        changed = true;
        const fixed = quoted(canonical, quoteChar);
        if (second === undefined) return `${keyword}${gap}${fixed}`;
        return `${keyword}${gap}${open ? quoted(first, open) : first}.${fixed}`;
      },
    );

  // A double quote is a string in MySQL but an identifier in Postgres, so the dialect decides.
  const doubleQuoteIsLiteral = quoteChar !== '"';
  // MySQL is the only engine here that escapes with a backslash, and the backtick identifies it.
  const backslashEscapes = quoteChar === '`';
  let out = '';
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const end = skipTo(sql, i, doubleQuoteIsLiteral, backslashEscapes);
    if (end >= 0) {
      out += fixCode(sql.slice(start, i)) + sql.slice(i, end);
      start = end;
      i = end;
    } else i++;
  }
  out += fixCode(sql.slice(start));
  return changed ? out : null;
}

/** A bare identifier, and whatever follows it, so a function call can be told from a column. */
const BARE_IDENTIFIER = /([A-Za-z_][\w$]*)(\s*[.(]?)/g;

/**
 * A reserved word is only treated as a name where it cannot be syntax: after FROM/JOIN/UPDATE/INTO,
 * or qualified by a dot. Accepting AS or "(" quoted the type in CAST(x AS DATE) and the field in
 * EXTRACT(MONTH FROM d), both of which are valid SQL that quoting breaks.
 */
const NAME_POSITION = /(?:\bfrom|\bjoin|\bupdate|\binto|\.)\s*$/i;

/** The first argument of these is a keyword, not a name: EXTRACT(MONTH FROM d), TRIM(BOTH x FROM s). */
/** Directly after one of these, a name before a dot is a schema rather than a table. */
const QUALIFIER_POSITION = /(?:\bfrom|\bjoin|\bupdate|\binto)\s+$/i;

const KEYWORD_ARGUMENT = /\b(?:extract|trim|position|overlay|substring)\s*\(\s*$/i;

/**
 * Quotes every table and column the engine would otherwise fold away. The schema text already shows
 * these names quoted and models still drop the quotes, so the query is normalised before it runs
 * rather than left to fail. Returns null when nothing needed quoting.
 */
export function quoteCatalogIdentifiers(
  sql: string,
  names: readonly string[],
  quoteChar: string,
  tableNames: readonly string[] = names,
): string | null {
  const tables = new Set(tableNames.map((n) => n.toLowerCase()));
  const byLower = new Map<string, string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (byLower.has(lower) && byLower.get(lower) !== name) byLower.set(lower, '');
    else if (!byLower.has(lower)) byLower.set(lower, name);
  }
  if (byLower.size === 0) return null;

  let changed = false;
  const fixCode = (code: string, chunkStart: number): string =>
    code.replace(BARE_IDENTIFIER, (whole, token: string, tail: string, offset: number) => {
      if (tail.trimStart().startsWith('(')) return whole; // a function call, not an identifier
      const canonical = byLower.get(token.toLowerCase());
      if (!canonical) return whole;
      const before = code.slice(0, offset);
      if (KEYWORD_ARGUMENT.test(before)) return whole;
      // TIMESTAMP '2024-01-01' and DATE '...' are typed literals: the word is syntax, not a name.
      // The literal is its own segment, so this reads the statement rather than the chunk.
      if (/^\s*'/.test(sql.slice(chunkStart + offset + token.length))) return whole;
      // A token before a dot qualifies what follows: after FROM/JOIN it is a SCHEMA, so a table of
      // the same name must not lend it its casing. Elsewhere it is table.column, where it should.
      if (tail.trimStart().startsWith('.') && (QUALIFIER_POSITION.test(before) || !tables.has(token.toLowerCase()))) {
        return whole;
      }
      // Rewriting a keyword blindly turns ORDER BY into "order" BY, so one must announce itself.
      if (ANY_RESERVED.has(token.toLowerCase()) && !NAME_POSITION.test(before)) return whole;
      changed = true;
      return `${quoted(canonical, quoteChar)}${tail}`;
    });

  const doubleQuoteIsLiteral = quoteChar !== '"';
  const backslashEscapes = quoteChar === '`';
  let out = '';
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    // An already-quoted identifier is opaque: re-quoting it would double the quote characters.
    if (sql[i] === quoteChar) {
      const close = sql.indexOf(CLOSING[quoteChar] ?? quoteChar, i + 1);
      const end = close === -1 ? sql.length : close + 1;
      out += fixCode(sql.slice(start, i), start) + sql.slice(i, end);
      start = end;
      i = end;
      continue;
    }
    const end = skipTo(sql, i, doubleQuoteIsLiteral, backslashEscapes);
    if (end >= 0) {
      out += fixCode(sql.slice(start, i), start) + sql.slice(i, end);
      start = end;
      i = end;
    } else i++;
  }
  out += fixCode(sql.slice(start), start);
  return changed ? out : null;
}

/**
 * The statement with string literals and comments blanked out, so a keyword search cannot match a
 * value like 'except this' or a table named in a comment. Length and offsets are preserved.
 */
export function withoutLiteralsAndComments(sql: string): string {
  let out = '';
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    // Quoted identifiers are code, not literals, so only ' and comments are blanked here.
    const end = skipTo(sql, i, false);
    if (end >= 0) {
      out += sql.slice(start, i) + ' '.repeat(end - i);
      start = end;
      i = end;
    } else i++;
  }
  return out + sql.slice(start);
}

/**
 * True when a text value opens and never closes, which is what an unescaped apostrophe looks like:
 * 'O'Brien' reads as the value 'O', then Brien, then a literal running to the end of the statement.
 * The parser only reports "could not parse", so naming the real cause is what makes the repair land.
 */
export function hasUnterminatedLiteral(sql: string, backslashEscapes = false): boolean {
  let open = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (open) {
      if (backslashEscapes && ch === '\\') i += 2;
      else if (ch === "'" && sql[i + 1] === "'")
        i += 2; // an escaped apostrophe, the value continues
      else if (ch === "'") {
        open = false;
        i++;
      } else i++;
      continue;
    }
    // A dollar-quoted body is a literal that needs no escaping, so an apostrophe inside is fine.
    if (ch === '$') {
      const dollar = skipTo(sql, i, false);
      if (dollar > i) {
        i = dollar;
        continue;
      }
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
    } else if (ch === "'") {
      open = true;
      i++;
    } else i++;
  }
  return open;
}

/**
 * An alias is just a name, so a reserved word used as one only needs quoting. A model writes
 * `RANK() OVER (...) AS rank`, which MySQL rejects outright because RANK is reserved there.
 *
 * A type is not an alias: the word after AS in CAST(x AS DATE) is followed by a closing bracket, and
 * quoting it would turn a cast into a reference to a column that does not exist.
 */
/** A clause keyword after an alias ends the select item; any other bare word means it was a type. */
const CLAUSE_KEYWORD = /^\s+(?:from|where|group|order|having|limit|offset|union|join|on|window|fetch|into)\b/i;
const RESERVED_ALIAS = /\bas\s+([A-Za-z_][\w$]*)\s*(?=,|\)|$|\s)/gi;

export function quoteReservedAliases(sql: string, quoteChar: string, engine: string): string | null {
  const reserved = reservedWordsFor(engine);
  let changed = false;
  const fixCode = (code: string): string =>
    code.replace(RESERVED_ALIAS, (whole, alias: string, offset: number) => {
      if (!reserved.has(alias.toLowerCase())) return whole;
      const rest = code.slice(offset + whole.length);
      // A closing bracket right after means this was a cast's type, not a select-list alias.
      if (/^\s*\)/.test(rest)) return whole;
      // So does a following bare word: CAST(x AS UNSIGNED INTEGER) would otherwise have its type
      // quoted, and the guard then rejects the statement and discards the whole rewrite.
      if (/^\s+[A-Za-z_]/.test(rest) && !CLAUSE_KEYWORD.test(rest)) return whole;
      changed = true;
      return whole.replace(alias, quoted(alias, quoteChar));
    });

  const doubleQuoteIsLiteral = quoteChar !== '"';
  const backslashEscapes = quoteChar === '`';
  let out = '';
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === quoteChar) {
      const close = sql.indexOf(CLOSING[quoteChar] ?? quoteChar, i + 1);
      const end = close === -1 ? sql.length : close + 1;
      out += fixCode(sql.slice(start, i)) + sql.slice(i, end);
      start = end;
      i = end;
      continue;
    }
    const end = skipTo(sql, i, doubleQuoteIsLiteral, backslashEscapes);
    if (end >= 0) {
      out += fixCode(sql.slice(start, i)) + sql.slice(i, end);
      start = end;
      i = end;
    } else i++;
  }
  out += fixCode(sql.slice(start));
  return changed ? out : null;
}

/** Matches the unknown-table wording of every engine AskSQL supports. */
const UNKNOWN_TABLE =
  /\b(doesn't exist|does not exist|not found|unknown table|invalid object name|undefined table|no such table|table or view does not exist)\b/i;

export function looksLikeUnknownTable(message: string): boolean {
  return UNKNOWN_TABLE.test(message);
}
