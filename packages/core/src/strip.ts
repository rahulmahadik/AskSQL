/**
 * Lexical pre-processing for the SQL guard. `stripCommentsAndStrings` replaces the content of
 * string literals, quoted identifiers and comments with a single space, so a lexical safety check
 * cannot be fooled by a keyword - or a second statement - hidden inside a literal.
 *
 * `maskCommentsAndStrings` hides the same spans but keeps every offset, for callers that locate
 * something in the masked text and then edit the original at that index.
 */
export function stripCommentsAndStrings(sql: string, engine?: string): string {
  return scan(sql, engine, false);
}

/** Same spans hidden as `stripCommentsAndStrings`, but character-for-character the same length. */
export function maskCommentsAndStrings(sql: string, engine?: string): string {
  return scan(sql, engine, true);
}

function scan(sql: string, engine: string | undefined, preserveLength: boolean): string {
  const hashIsComment = engine === undefined || engine === 'mysql';
  // MySQL honours \' inside a plain literal; PostgreSQL with standard_conforming_strings does not.
  const backslashEscapes = engine === 'mysql';
  const out: string[] = [];
  const n = sql.length;
  let i = 0;

  const isTagChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  /** `text` is what strip mode emits; mask mode emits blanks matching the span it consumed. */
  // Clamp to n: an unterminated literal can leave i past the end, which would pad too far.
  const hide = (start: number, text: string) => out.push(preserveLength ? ' '.repeat(Math.min(i, n) - start) : text);

  while (i < n) {
    const spanStart = i;
    const c = sql[i]!;
    const next = i + 1 < n ? sql[i + 1]! : '';

    // -- line comment (ends at CR or LF; a lone CR must not hide trailing text)
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      hide(spanStart, ' ');
      continue;
    }
    // # line comment (MySQL)
    if (c === '#' && hashIsComment) {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      hide(spanStart, ' ');
      continue;
    }
    // /* block comment */ with nesting
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      hide(spanStart, ' ');
      continue;
    }
    // Dollar-quoted string: $$...$$ or $tag$...$tag$
    if (c === '$') {
      let j = i + 1;
      while (j < n && isTagChar(sql[j]!)) j++;
      if (j < n && sql[j] === '$') {
        const tag = sql.slice(i, j + 1); // e.g. "$$" or "$fn$"
        const close = sql.indexOf(tag, j + 1);
        i = close === -1 ? n : close + tag.length;
        hide(spanStart, ' ');
        continue;
      }
    }
    // E'...' backslash-escape string (PostgreSQL); the `E` must start a token, or `LIKE'x'` is misread.
    if ((c === 'e' || c === 'E') && next === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      i += 2;
      while (i < n) {
        if (sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      hide(spanStart, ' ');
      continue;
    }
    // 'string' with '' escape, plus \' on MySQL where a backslash escapes inside a plain literal.
    if (c === "'") {
      i++;
      while (i < n) {
        if (backslashEscapes && sql[i] === '\\' && i + 1 < n) i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      hide(spanStart, ' ');
      continue;
    }
    // "quoted identifier" ("" escape)
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
      hide(spanStart, ' " '); // keep a marker so identifier positions stay visible
      continue;
    }
    // `backtick identifier`
    if (c === '`') {
      i++;
      while (i < n && sql[i] !== '`') i++;
      i++;
      hide(spanStart, ' ` ');
      continue;
    }
    // [bracket identifier]
    if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      if (close !== -1) {
        i = close + 1;
        hide(spanStart, ' ');
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** Single-character whitespace test (Unicode, matching what /[;\s]+$/u used to trim). */
const TRAILING_WS = /\s/u;

/** True when the stripped SQL contains an internal statement separator. */
export function hasMultipleStatements(strippedSql: string): boolean {
  // Trailing `;`/whitespace is skipped by hand: an end-anchored /[;\s]+$/ backtracks at every
  // position of a long whitespace run, which is quadratic in the statement length.
  let end = strippedSql.length;
  while (end > 0) {
    const c = strippedSql[end - 1]!;
    if (c === ';' || TRAILING_WS.test(c)) end--;
    else break;
  }
  return strippedSql.lastIndexOf(';', end - 1) !== -1;
}

/** Trim trailing whitespace, semicolons and comments, preserving string literals and earlier comments. */
export function trimTrailingNoise(sql: string, engine?: string): string {
  const hashIsComment = engine === undefined || engine === 'mysql';
  const n = sql.length;
  let i = 0;
  let lastReal = 0; // index just past the last significant (non-noise) character

  const isTagChar = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = sql[i]!;
    const next = i + 1 < n ? sql[i + 1]! : '';

    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    if (c === '#' && hashIsComment) {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < n && isTagChar(sql[j]!)) j++;
      if (j < n && sql[j] === '$') {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        i = close === -1 ? n : close + tag.length;
        lastReal = i;
        continue;
      }
    }
    if ((c === 'e' || c === 'E') && next === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      i += 2;
      while (i < n) {
        if (sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      lastReal = i;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      lastReal = i;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
      lastReal = i;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < n && sql[i] !== '`') i++;
      i++;
      lastReal = i;
      continue;
    }
    if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      if (close !== -1) {
        i = close + 1;
        lastReal = i;
        continue;
      }
    }
    // Ordinary character: whitespace and `;` are noise (multi-statement SQL is blocked upstream).
    if (!/\s/.test(c) && c !== ';') lastReal = i + 1;
    i++;
  }
  return sql.slice(0, lastReal);
}
