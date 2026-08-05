package com.rahulmahadik.asksql.ide.guard

/**
 * Dialect-independent lexical scanning run by [SqlGuard] before AST parsing (core's `strip.ts`). Known
 * gaps vs core: block comments don't nest and `[bracket]` identifiers aren't recognized.
 */
object SqlLexer {

    /** Blanks comments and string/quoted-identifier contents, space-padded to preserve offsets. */
    fun stripCommentsAndStrings(sql: String): String {
        val out = StringBuilder(sql.length)
        var i = 0
        val n = sql.length
        while (i < n) {
            val c = sql[i]

            // Line comments: -- ... and MySQL's # ... The space keeps the tokens on either side from merging.
            if (c == '-' && i + 1 < n && sql[i + 1] == '-') {
                while (i < n && sql[i] != '\n' && sql[i] != '\r') i++
                out.append(' ')
                continue
            }
            if (c == '#') {
                while (i < n && sql[i] != '\n' && sql[i] != '\r') i++
                out.append(' ')
                continue
            }
            // Block comments: /* ... */ (non-nesting; see the class doc).
            if (c == '/' && i + 1 < n && sql[i + 1] == '*') {
                i += 2
                while (i + 1 < n && !(sql[i] == '*' && sql[i + 1] == '/')) i++
                i += 2
                out.append(' ')
                continue
            }
            // Dollar-quoted string: $$...$$ or $tag$...$tag$. An apostrophe inside one is data,
            // and without this branch it opens a string that swallows the rest of the statement.
            if (c == '$') {
                var j = i + 1
                while (j < n && (sql[j].isLetterOrDigit() || sql[j] == '_')) j++
                if (j < n && sql[j] == '$') {
                    val tag = sql.substring(i, j + 1)
                    val close = sql.indexOf(tag, j + 1)
                    val end = if (close == -1) n else close + tag.length
                    out.append(" ".repeat(end - i))
                    i = end
                    continue
                }
            }
            // E'...': PostgreSQL's escape-string form, the ONLY plain-string form where a backslash escapes a quote.
            // The E must start a token, or the trailing E of `LIKE'x'` is misread as an E-string.
            if ((c == 'e' || c == 'E') && i + 1 < n && sql[i + 1] == '\'' &&
                (i == 0 || !sql[i - 1].isLetterOrDigit() && sql[i - 1] != '_' && sql[i - 1] != '$')
            ) {
                out.append("  ")
                i += 2
                while (i < n) {
                    if (sql[i] == '\\' && i + 1 < n) { out.append("  "); i += 2; continue }
                    if (sql[i] == '\'' && i + 1 < n && sql[i + 1] == '\'') { out.append("  "); i += 2; continue }
                    if (sql[i] == '\'') { out.append(' '); i++; break }
                    out.append(' ')
                    i++
                }
                continue
            }
            // String / quoted-identifier literals: '...', "...", `...`. Doubled quotes ('' and "") escape; a backslash does not.
            // PostgreSQL with standard_conforming_strings=on (its default) ends the literal at the second quote.
            if (c == '\'' || c == '"' || c == '`') {
                val quote = c
                // The quote characters survive as markers, so a rule can still tell a quoted identifier from a bare one.
                out.append(if (quote == '\'') ' ' else quote)
                i++
                while (i < n) {
                    val cur = sql[i]
                    if (cur == quote && quote != '`' && i + 1 < n && sql[i + 1] == quote) {
                        out.append("  ")
                        i += 2
                        continue
                    }
                    if (cur == quote) {
                        out.append(if (quote == '\'') ' ' else quote)
                        i++
                        break
                    }
                    out.append(' ')
                    i++
                }
                continue
            }
            out.append(c)
            i++
        }
        return out.toString()
    }

    /**
     * True when the (already stripped) SQL contains more than one statement: a trailing semicolon is
     * fine, anything non-whitespace after an internal one is a second statement.
     */
    fun hasMultipleStatements(stripped: String): Boolean {
        val trimmed = stripped.trim()
        val firstSemi = trimmed.indexOf(';')
        if (firstSemi == -1) return false
        val rest = trimmed.substring(firstSemi + 1).trim()
        return rest.isNotEmpty()
    }
}
