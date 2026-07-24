package com.rahulmahadik.asksql.ide.engine

/** SQL extraction from model output (same behavior as core's `extract.ts`): fenced blocks, prose wrapping, multiple fences. */
object Extract {

    enum class ExtractionSource { FENCE, INLINE, WHOLE }

    data class Extraction(val sql: String, val explanation: String, val source: ExtractionSource = ExtractionSource.FENCE)

    // \w* (not a literal "sql"/"SQL") matches ANY fence language tag, so
    // ```postgresql, ```MySQL, ```sqlite, etc. are still recognized as fenced blocks.
    private val FENCE_RE = Regex("""```\w*\s*\n?([\s\S]*?)```""")

    /** Any statement-shaped start, including write/DDL verbs: the guard, not the extractor, decides what may run. */
    private val SQL_START_RE = Regex(
        """^(select|with|explain|show|describe|desc|pragma|insert|update|delete|drop|create|alter|truncate|merge|replace|call|grant|revoke|copy|values|table)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** Conservative set for INLINE extraction from prose: read verbs only, to avoid grabbing English sentences that begin with "Update"/"Insert". */
    private val INLINE_START_RE = Regex(
        """(?:^|\n)\s*((?:select|with|explain)\b[\s\S]*?)(?=\n\s*\n|$)""",
        RegexOption.IGNORE_CASE,
    )

    // Case-sensitive to match core exactly: the model emits this sentinel verbatim in
    // uppercase, so a lowercase "impossible:" is ordinary prose, not the sentinel.
    private val IMPOSSIBLE_SENTINEL = Regex(
        """^\s*IMPOSSIBLE\s*:\s*(.+)""",
        RegexOption.DOT_MATCHES_ALL,
    )

    /** Trims a fence's trailing `-- Explanation:`/`-- Note:` commentary, for a model that writes prose without closing the fence first. */
    private val TRAILING_PROSE_RE = Regex("""\n\s*--\s*(Explanation|Note)\b.*""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

    private val REFUSAL = Regex(
        """\b(i can(?:no|')t|i cannot|i am unable|i'm unable|i'm sorry|as an ai)\b""",
        RegexOption.IGNORE_CASE,
    )

    private const val REASON_MAX_LENGTH = 300

    /** The sentinel word is internal protocol; a model that repeats it mid-sentence must not leak it into the chat. */
    private val SENTINEL_WORD = Regex("""\bIMPOSSIBLE\b\s*:?\s*""", RegexOption.IGNORE_CASE)

    /** "Your question isn't about this data" said many robotic ways; all of them collapse to one plain sentence. */
    private val OFF_TOPIC = Regex(
        """\b(the )?question (cannot be answered|is not|isn't)\b[^.]*\b(not related to|unrelated to|does not relate)\b|""" +
            """\bnot related to the (provided )?schema\b""",
        RegexOption.IGNORE_CASE,
    )

    /** Model-speak to plain English, applied in order. Deterministic and local: no second model call. */
    private val PHRASINGS = listOf(
        Regex("""\bthe provided schema\b""", RegexOption.IGNORE_CASE) to "this database",
        Regex("""\bthe (given |current )?schema\b""", RegexOption.IGNORE_CASE) to "this database",
        Regex("""\bdoes not contain any information (about|on|related to)\b""", RegexOption.IGNORE_CASE) to "doesn't have anything about",
        Regex("""\bdoes not contain any\b""", RegexOption.IGNORE_CASE) to "doesn't have any",
        Regex("""\bdoes not contain\b""", RegexOption.IGNORE_CASE) to "doesn't have",
        Regex("""\bdoes not (include|have|provide)\b""", RegexOption.IGNORE_CASE) to "doesn't have",
        Regex("""\bis not able to\b|\bcannot be\b""", RegexOption.IGNORE_CASE) to "can't be",
    )

    /** Rewrites a model's stiff refusal into something readable, keeping its specifics. */
    private fun humanizeReason(reason: String): String {
        if (OFF_TOPIC.containsMatchIn(reason)) return "That question isn't about the data in this database."
        var out = reason
        for ((pattern, replacement) in PHRASINGS) out = pattern.replace(out, replacement)
        return out.replace(Regex("""\s{2,}"""), " ").trim()
    }

    /** The prompt asks for "IMPOSSIBLE: <one-line reason>"; a noncompliant model rambles on, so only the first line is the reason. */
    fun extractImpossible(text: String): String? {
        val captured = IMPOSSIBLE_SENTINEL.find(text.trim())?.groupValues?.get(1)?.trim() ?: return null
        val firstLine = captured.substringBefore('\n').trim()
        val cleaned = SENTINEL_WORD.replace(firstLine, "").trim()
        val humanized = humanizeReason(cleaned).replaceFirstChar { it.uppercase() }
        return truncateAtWordBoundary(humanized, REASON_MAX_LENGTH)
    }

    private fun truncateAtWordBoundary(text: String, maxLength: Int): String {
        if (text.length <= maxLength) return text
        val cut = text.take(maxLength)
        val lastSpace = cut.lastIndexOf(' ')
        return (if (lastSpace > maxLength / 2) cut.take(lastSpace) else cut).trimEnd() + "…"
    }

    fun extractSql(text: String): Extraction? {
        // 1) Fenced blocks: first block that looks like a query wins.
        for (f in FENCE_RE.findAll(text)) {
            var candidate = f.groupValues[1].trim()
            if (candidate.isNotEmpty() && SQL_START_RE.containsMatchIn(candidate)) {
                val trailingProse = TRAILING_PROSE_RE.find(candidate)
                if (trailingProse != null) candidate = candidate.substring(0, trailingProse.range.first).trimEnd()
                val explanation = text.replaceFirst(f.value, " ").replace(Regex("""```[\s\S]*?```"""), " ")
                return Extraction(candidate, tidy(explanation), ExtractionSource.FENCE)
            }
        }

        // 2) Whole message is SQL.
        val trimmed = text.trim()
        if (SQL_START_RE.containsMatchIn(trimmed)) {
            return Extraction(trimmed, "", ExtractionSource.WHOLE)
        }

        // 3) Inline: first SELECT/WITH/EXPLAIN run up to a blank line or end.
        val inline = INLINE_START_RE.find(text)
        if (inline != null) {
            val sql = inline.groupValues[1].trim()
            if (sql.length > 8) {
                return Extraction(sql, tidy(text.replaceFirst(inline.groupValues[1], " ")), ExtractionSource.INLINE)
            }
        }
        return null
    }

    fun looksLikeRefusal(text: String): Boolean = REFUSAL.containsMatchIn(text)

    private fun tidy(explanation: String): String =
        explanation.replace(Regex("""\s+"""), " ").trim().take(2000)
}
