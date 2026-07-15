/**
 * Lexical pre-processing for the SQL guard.
 *
 * `stripCommentsAndStrings` removes the CONTENT of string literals, quoted
 * identifiers and comments (replacing each region with a single space) so
 * lexical safety checks (`FOR UPDATE`, `INTO OUTFILE`, semicolon counting)
 * can never be fooled by keywords hidden inside literals - and so literals
 * can never hide a second statement.
 *
 * Handles: 'single' ('' escape), "double" identifiers, `backtick`
 * identifiers, [bracket] identifiers, E'...' with backslash escapes,
 * $$dollar$$ and $tag$tagged$tag$ quoting (PostgreSQL), -- line comments,
 * # line comments (MySQL), and /* block comments *​/ with nesting
 * (PostgreSQL nests them).
 */
export function stripCommentsAndStrings(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;

  const isTagChar = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = sql[i]!;
    const next = i + 1 < n ? sql[i + 1]! : '';

    // -- line comment (ends at CR or LF; a lone CR must not hide trailing text)
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out.push(' ');
      continue;
    }
    // # line comment (MySQL)
    if (c === '#') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out.push(' ');
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
      out.push(' ');
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
        out.push(' ');
        continue;
      }
    }
    // E'...' backslash-escape string (PostgreSQL). The `E` must START a token:
    // otherwise the trailing E of `LIKE'x'` / `date'...'` is misread as an E-string,
    // treating `\'` as an escaped quote and running past the literal, which hides a
    // following `;` from the multi-statement check. Never widen without a test.
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
      out.push(' ');
      continue;
    }
    // 'string' with '' escape
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out.push(' ');
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
      out.push(' " '); // keep a marker so identifier positions stay visible
      continue;
    }
    // `backtick identifier`
    if (c === '`') {
      i++;
      while (i < n && sql[i] !== '`') i++;
      i++;
      out.push(' ` ');
      continue;
    }
    // [bracket identifier]
    if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      if (close !== -1) {
        i = close + 1;
        out.push(' ');
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** True when the stripped SQL contains an internal statement separator. */
export function hasMultipleStatements(strippedSql: string): boolean {
  const body = strippedSql.replace(/[;\s]+$/u, '');
  return body.includes(';');
}
