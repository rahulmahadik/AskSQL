package com.rahulmahadik.asksql.ide.guard

/**
 * Dialect-independent lexical scanning run by [SqlGuard] before AST parsing (core's `strip.ts`). Known
 * gaps vs core: block comments don't nest, and dollar-quoted strings, `E'...'`, and `[bracket]` identifiers aren't recognized.
 */
object SqlLexer {

    /**
     * Blanks comments and string/quoted-identifier contents (space-padded to preserve offsets), so
     * downstream checks never trip on a semicolon or keyword inside a comment or literal.
     */
    fun stripCommentsAndStrings(sql: String): String {
        val out = StringBuilder(sql.length)
        var i = 0
        val n = sql.length
        while (i < n) {
            val c = sql[i]

            // Line comments: -- ... and MySQL's # ...
            // The space marks where the comment was, so tokens on either
            // side never merge (e.g. `FOR/**/UPDATE` staying two words).
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
            // Block comments: /* ... */ (non-nesting; see class doc for the
            // one known divergence from core's nesting behavior).
            if (c == '/' && i + 1 < n && sql[i + 1] == '*') {
                i += 2
                while (i + 1 < n && !(sql[i] == '*' && sql[i + 1] == '/')) i++
                i += 2
                out.append(' ')
                continue
            }
            // String / quoted-identifier literals: '...', "...", `...`.
            // Doubled-quote ('') and backslash escapes are honored so an
            // escaped quote never prematurely ends the literal.
            if (c == '\'' || c == '"' || c == '`') {
                val quote = c
                out.append(' ')
                i++
                while (i < n) {
                    val cur = sql[i]
                    if (cur == '\\' && quote != '`' && i + 1 < n) {
                        out.append("  ")
                        i += 2
                        continue
                    }
                    if (cur == quote && i + 1 < n && sql[i + 1] == quote) {
                        out.append("  ")
                        i += 2
                        continue
                    }
                    if (cur == quote) {
                        out.append(' ')
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
