package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.SchemaCatalog

/** Finds a real table name that is a likely misspelling of a word in the question. */
object SchemaFuzzyMatch {

    private val WORD_RE = Regex("""[A-Za-z][A-Za-z0-9_]{2,}""")

    fun closestTableName(question: String, catalog: SchemaCatalog): String? {
        val words = WORD_RE.findAll(question).map { it.value.lowercase() }.toSet()
        if (words.isEmpty()) return null

        var best: String? = null
        var bestDistance = Int.MAX_VALUE
        for (word in words) {
            for (table in catalog.tables) {
                val name = table.name.lowercase()
                if (name == word) continue // an exact match means the table exists
                val threshold = maxOf(1, minOf(word.length, name.length) / 4)
                val distance = levenshtein(word, name)
                if (distance <= threshold && distance < bestDistance) {
                    bestDistance = distance
                    best = table.name
                }
            }
        }
        return best
    }

    private fun levenshtein(a: String, b: String): Int {
        val dp = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) dp[i][0] = i
        for (j in 0..b.length) dp[0][j] = j
        for (i in 1..a.length) {
            for (j in 1..b.length) {
                dp[i][j] = if (a[i - 1] == b[j - 1]) {
                    dp[i - 1][j - 1]
                } else {
                    1 + minOf(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
                }
            }
        }
        return dp[a.length][b.length]
    }

    /** Words that carry no schema meaning, so a question made only of these names nothing in particular. */
    private val QUESTION_NOISE: Set<String> = (
        "what which how many show me all the a an is are was were do does did have has list of in on for " +
            "per each every there their it its to from by and or not no with that this these those give tell find get top " +
            "most least largest biggest highest lowest average total sum count number rows records value values who whom whose " +
            "when where why can could would should us we our you your my long longest shortest never ever any some more than " +
            "less over under between about into out up down after before during year years month months day days week weeks " +
            "time date dates spent using called new old good best worst same different table tables column columns database"
        ).split(" ").toSet()

    private fun singularOfWord(w: String): String = when {
        w.endsWith("ies") -> w.dropLast(3) + "y"
        w.endsWith("s") && !w.endsWith("ss") -> w.dropLast(1)
        else -> w
    }

    private val QUESTION_WORD_RE = Regex("""[a-z_][\w]*""")

    /**
     * True when the question mentions something the catalog actually holds.
     *
     * A question that names nothing known is either about structure, or about a relation added since
     * the catalog was read. The second case answers the wrong question silently: asked for invoices
     * with only customers in the catalog, a model will happily count customers.
     */
    fun namesSomethingInCatalog(question: String, catalog: SchemaCatalog): Boolean {
        val known = HashSet<String>()
        for (t in catalog.tables) {
            known += t.name.lowercase()
            known += singularOfWord(t.name.lowercase())
            for (c in t.columns) {
                known += c.name.lowercase()
                known += singularOfWord(c.name.lowercase())
            }
        }
        if (known.isEmpty()) return true // nothing to match against; a refresh would not help

        val words = QUESTION_WORD_RE.findAll(question.lowercase()).map { it.value }
            .filter { it.length > 2 && it !in QUESTION_NOISE }
            .toList()
        return words.any { w ->
            w in known || singularOfWord(w) in known ||
                known.any { k -> k.length > 3 && (k.contains(w) || w.contains(k)) }
        }
    }
}
