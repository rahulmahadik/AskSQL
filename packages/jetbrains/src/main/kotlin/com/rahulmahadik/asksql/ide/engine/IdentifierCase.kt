package com.rahulmahadik.asksql.ide.engine

/**
 * A table named in the wrong case is the one database rejection a catalog can repair on its own,
 * with no model round trip. MySQL on Linux compares table names case-sensitively, and Postgres and
 * Oracle fold unquoted names, so the corrected name is quoted to survive either rule.
 */
object IdentifierCase {

    /** The union across engines: treating a word as syntax is the conservative side of this decision. */
    private val ANY_RESERVED = SqlKeywords.reservedWordsFor("*")

    /** Only these lead-ins put an identifier in table position, which keeps a same-named column alone. */
    private val TABLE_POSITION =
        Regex("""\b(from|join|update|into)(\s+)([`"\[]?)([A-Za-z_][\w$]*)[`"\]]?(\s*\.\s*([`"\[]?)([A-Za-z_][\w$]*)[`"\]]?)?""", RegexOption.IGNORE_CASE)

    private val UNKNOWN_TABLE =
        Regex("""\b(doesn't exist|does not exist|not found|unknown table|invalid object name|undefined table|no such table|table or view does not exist)\b""", RegexOption.IGNORE_CASE)

    fun looksLikeUnknownTable(message: String): Boolean = UNKNOWN_TABLE.containsMatchIn(message)

    private fun quoted(name: String, quoteChar: Char): String {
        val close = if (quoteChar == '[') ']' else quoteChar
        return "$quoteChar$name$close"
    }

    /** Where a literal or comment ends, or -1 when the position starts neither. */
    /** A dollar-quoted body is a literal in Postgres and DuckDB, and may contain anything. */
    private val DOLLAR_OPEN = Regex("""\$[A-Za-z_]\w*\$|\$\$""")

    private fun skipTo(sql: String, i: Int, doubleQuoteIsLiteral: Boolean, backslashEscapes: Boolean = false): Int {
        val ch = sql[i]
        val next = if (i + 1 < sql.length) sql[i + 1] else ' '
        if (ch == '$') {
            val open = DOLLAR_OPEN.matchAt(sql, i)
            if (open != null) {
                val close = sql.indexOf(open.value, i + open.value.length)
                return if (close == -1) sql.length else close + open.value.length
            }
        }
        if (ch == '-' && next == '-') {
            val nl = sql.indexOf('\n', i)
            return if (nl == -1) sql.length else nl
        }
        if (ch == '/' && next == '*') {
            val close = sql.indexOf("*/", i + 2)
            return if (close == -1) sql.length else close + 2
        }
        if (ch == '\'' || (ch == '"' && doubleQuoteIsLiteral)) {
            var j = i + 1
            while (j < sql.length) {
                when {
                    backslashEscapes && sql[j] == '\\' -> j += 2
                    sql[j] == ch -> if (j + 1 < sql.length && sql[j + 1] == ch) j += 2 else return j + 1
                    else -> j++
                }
            }
            return sql.length
        }
        return -1
    }

    /** How an engine resolves an unquoted identifier: Postgres lower-cases it, Oracle upper-cases it. */
    enum class Folding { LOWER, UPPER, NONE }

    fun foldingFor(engine: String): Folding = when (engine.lowercase()) {
        "postgres" -> Folding.LOWER
        "oracle" -> Folding.UPPER
        else -> Folding.NONE
    }

    private fun folded(name: String, folding: Folding): String = when (folding) {
        Folding.LOWER -> name.lowercase()
        Folding.UPPER -> name.uppercase()
        Folding.NONE -> name
    }

    /** Returns the rewritten SQL, or null when no table reference needed correcting. */
    fun correctTableCase(
        sql: String,
        tableNames: List<String>,
        quoteChar: Char,
        folding: Folding = Folding.NONE,
    ): String? {
        val byLower = HashMap<String, String>()
        for (name in tableNames) {
            val lower = name.lowercase()
            // An ambiguous fold has no single right answer, so leave those names untouched.
            if (byLower.containsKey(lower) && byLower[lower] != name) byLower[lower] = "" else byLower.putIfAbsent(lower, name)
        }

        var changed = false
        fun fixCode(code: String): String = TABLE_POSITION.replace(code) { m ->
            val keyword = m.groupValues[1]
            val gap = m.groupValues[2]
            val open = m.groupValues[3]
            val first = m.groupValues[4]
            val second = m.groupValues[7]
            val target = second.ifEmpty { first }
            val open2 = m.groupValues[6]
            val canonical = byLower[target.lowercase()]
            // A third part means what matched is a qualifier: prod.sales.orders names orders, not sales.
            val restStartsWithDot = code.substring(m.range.last + 1).trimStart().startsWith(".")
            // An unquoted name is resolved folded, so what matters is what the database will look up.
            val wasQuoted = (if (second.isEmpty()) open else open2).isNotEmpty()
            val resolvesTo = if (wasQuoted) target else folded(target, folding)
            if (canonical.isNullOrEmpty() || restStartsWithDot || resolvesTo == canonical) {
                m.value
            } else {
                changed = true
                val fixed = quoted(canonical, quoteChar)
                if (second.isEmpty()) "$keyword$gap$fixed"
                else "$keyword$gap${if (open.isNotEmpty()) quoted(first, open[0]) else first}.$fixed"
            }
        }

        // A double quote is a string in MySQL but an identifier in Postgres, so the dialect decides.
        val doubleQuoteIsLiteral = quoteChar != '"'
        // MySQL is the only engine here that escapes with a backslash, and the backtick identifies it.
        val backslashEscapes = quoteChar == '`'
        val out = StringBuilder()
        var start = 0
        var i = 0
        while (i < sql.length) {
            val end = skipTo(sql, i, doubleQuoteIsLiteral, backslashEscapes)
            if (end >= 0) {
                out.append(fixCode(sql.substring(start, i))).append(sql, i, end)
                start = end
                i = end
            } else i++
        }
        out.append(fixCode(sql.substring(start)))
        return if (changed) out.toString() else null
    }

    /** A bare identifier, and whatever follows it, so a function call can be told from a column. */
    private val BARE_IDENTIFIER = Regex("""([A-Za-z_][\w$]*)(\s*[.(]?)""")

    /**
     * A reserved word is only treated as a name where it cannot be syntax: after FROM/JOIN/UPDATE/INTO,
     * or qualified by a dot. Accepting AS or "(" quoted the type in CAST(x AS DATE) and the field in
     * EXTRACT(MONTH FROM d), both of which are valid SQL that quoting breaks.
     */
    private val NAME_POSITION = Regex("""(?:\bfrom|\bjoin|\bupdate|\binto|\.)\s*$""", RegexOption.IGNORE_CASE)

    /** The first argument of these is a keyword, not a name: EXTRACT(MONTH FROM d), TRIM(BOTH x FROM s). */
    private val KEYWORD_ARGUMENT =
        Regex("""\b(?:extract|trim|position|overlay|substring)\s*\(\s*$""", RegexOption.IGNORE_CASE)

    /**
     * Quotes every table and column the engine would not read back as itself. The schema text already
     * shows these names quoted and models still drop the quotes, so the query is normalised before it
     * runs rather than left to fail. Returns null when nothing needed quoting.
     */
    fun quoteCatalogIdentifiers(
        sql: String,
        names: List<String>,
        quoteChar: Char,
        tableNames: List<String> = names,
    ): String? {
        val tables = tableNames.map { it.lowercase() }.toSet()
        val byLower = HashMap<String, String>()
        for (name in names) {
            val lower = name.lowercase()
            if (byLower.containsKey(lower) && byLower[lower] != name) byLower[lower] = "" else byLower.putIfAbsent(lower, name)
        }
        if (byLower.isEmpty()) return null

        var changed = false
        fun fixCode(code: String, chunkStart: Int): String = BARE_IDENTIFIER.replace(code) { m ->
            val token = m.groupValues[1]
            val tail = m.groupValues[2]
            val canonical = byLower[token.lowercase()]
            val before = code.substring(0, m.range.first)
            // TIMESTAMP '2024-01-01' is one typed literal; the literal is its own segment, so this
            // reads the statement rather than the chunk.
            val typedLiteral = sql.drop(chunkStart + m.range.first + token.length).trimStart().startsWith("'")
            // Rewriting a keyword blindly turns ORDER BY into "order" BY, so one must announce itself.
            val keywordOutOfPlace = token.lowercase() in ANY_RESERVED &&
                !NAME_POSITION.containsMatchIn(before)
            // A token before a dot qualifies what follows; quoting a schema name breaks a working query.
            val qualifierNotATable = tail.trimStart().startsWith(".") && token.lowercase() !in tables
            if (tail.trimStart().startsWith("(") || canonical.isNullOrEmpty() || keywordOutOfPlace ||
                KEYWORD_ARGUMENT.containsMatchIn(before) || qualifierNotATable || typedLiteral
            ) {
                m.value
            } else {
                changed = true
                "${quoted(canonical, quoteChar)}$tail"
            }
        }

        val doubleQuoteIsLiteral = quoteChar != '"'
        val backslashEscapes = quoteChar == '`'
        val out = StringBuilder()
        var start = 0
        var i = 0
        while (i < sql.length) {
            // An already-quoted identifier is opaque: re-quoting it would double the quote characters.
            if (sql[i] == quoteChar) {
                val closeChar = if (quoteChar == '[') ']' else quoteChar
                val close = sql.indexOf(closeChar, i + 1)
                val end = if (close == -1) sql.length else close + 1
                out.append(fixCode(sql.substring(start, i), start)).append(sql, i, end)
                start = end
                i = end
                continue
            }
            val end = skipTo(sql, i, doubleQuoteIsLiteral, backslashEscapes)
            if (end >= 0) {
                out.append(fixCode(sql.substring(start, i), start)).append(sql, i, end)
                start = end
                i = end
            } else i++
        }
        out.append(fixCode(sql.substring(start), start))
        return if (changed) out.toString() else null
    }

    /**
     * True when a text value opens and never closes, which is what an unescaped apostrophe looks like:
     * 'O'Brien' reads as the value 'O', then Brien, then a literal running to the end of the statement.
     * The parser only reports "could not parse", so naming the real cause is what makes the repair land.
     */
    fun hasUnterminatedLiteral(sql: String, backslashEscapes: Boolean = false): Boolean {
        var open = false
        var i = 0
        while (i < sql.length) {
            val ch = sql[i]
            if (open) {
                when {
                    backslashEscapes && ch == '\\' -> i += 2
                    ch == '\'' && i + 1 < sql.length && sql[i + 1] == '\'' -> i += 2
                    ch == '\'' -> { open = false; i++ }
                    else -> i++
                }
                continue
            }
            // A dollar-quoted body needs no escaping, so an apostrophe inside it is not a defect.
            if (ch == '$') {
                val dollar = skipTo(sql, i, false)
                if (dollar > i) { i = dollar; continue }
            }
            when {
                ch == '-' && i + 1 < sql.length && sql[i + 1] == '-' -> {
                    val nl = sql.indexOf('\n', i)
                    i = if (nl == -1) sql.length else nl
                }
                ch == '/' && i + 1 < sql.length && sql[i + 1] == '*' -> {
                    val close = sql.indexOf("*/", i + 2)
                    i = if (close == -1) sql.length else close + 2
                }
                ch == '\'' -> { open = true; i++ }
                else -> i++
            }
        }
        return open
    }
}
