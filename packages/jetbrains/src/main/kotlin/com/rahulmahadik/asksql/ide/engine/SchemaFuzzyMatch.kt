package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.SchemaCatalog

/**
 * Finds a real table name that's a likely misspelling of a question word, so a model that refused
 * ("no such table") can retry with the real name, told to disclose the correction rather than silently guess.
 */
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
                if (name == word) continue // an exact match means the table exists; not the case this is for
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
}
