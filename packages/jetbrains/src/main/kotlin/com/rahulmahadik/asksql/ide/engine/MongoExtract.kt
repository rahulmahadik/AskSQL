package com.rahulmahadik.asksql.ide.engine

/** Pipeline extraction from model output for MongoDB: the model emits ordinary `mongosh` syntax, `db.<collection>.aggregate([...])`, not a custom JSON schema. */
object MongoExtract {

    enum class ExtractionSource { FENCE, WHOLE }

    data class Extraction(val collection: String, val pipelineJson: String, val explanation: String, val source: ExtractionSource)

    private val FENCE_RE = Regex("""```(?:js|javascript|json)?\s*\n?([\s\S]*?)```""")

    /** `db.<name>.aggregate(` needs a valid JS identifier, so hyphen/dot names also arrive as `db.getCollection("name")` or `db["name"]`. */
    private val AGGREGATE_CALL_RE = Regex(
        """db(?:\.getCollection\(\s*["']([^"']+)["']\s*\)|\[\s*["']([^"']+)["']\s*]|\.([A-Za-z_][A-Za-z0-9_]*))\.aggregate\s*\(""",
    )

    fun extractPipeline(text: String): Extraction? {
        // 1) Fenced blocks: first block that looks like an aggregate() call wins.
        for (f in FENCE_RE.findAll(text)) {
            val candidate = f.groupValues[1].trim()
            val extracted = extractFrom(candidate) ?: continue
            val explanation = text.replaceFirst(f.value, " ").replace(Regex("""```[\s\S]*?```"""), " ")
            return Extraction(extracted.first, extracted.second, tidy(explanation), ExtractionSource.FENCE)
        }

        // 2) Whole message is the call, unfenced.
        val trimmed = text.trim()
        extractFrom(trimmed)?.let { (collection, pipeline) ->
            return Extraction(collection, pipeline, "", ExtractionSource.WHOLE)
        }

        return null
    }

    /** Finds `db.<name>.aggregate(` and returns (collectionName, pipelineArrayText) if the call's argument is a JSON array. */
    private fun extractFrom(candidate: String): Pair<String, String>? {
        val match = AGGREGATE_CALL_RE.find(candidate) ?: return null
        val collection = match.groupValues[1].ifEmpty { match.groupValues[2] }.ifEmpty { match.groupValues[3] }
        val openParenIndex = match.range.last // AGGREGATE_CALL_RE ends in \(, so this is that '(' index
        val closeParenIndex = findMatchingClose(candidate, openParenIndex) ?: return null
        val inner = candidate.substring(openParenIndex + 1, closeParenIndex).trim()
        if (!inner.startsWith("[")) return null
        return collection to inner
    }

    /** Index of the bracket matching `openIndex`, skipping brackets inside JSON string literals. */
    private fun findMatchingClose(text: String, openIndex: Int): Int? {
        val open = text[openIndex]
        val close = when (open) {
            '(' -> ')'
            '[' -> ']'
            '{' -> '}'
            else -> return null
        }
        var depth = 0
        var i = openIndex
        var inString = false
        while (i < text.length) {
            val c = text[i]
            if (inString) {
                when (c) {
                    '\\' -> i++
                    '"' -> inString = false
                }
            } else {
                when (c) {
                    '"' -> inString = true
                    open -> depth++
                    close -> {
                        depth--
                        if (depth == 0) return i
                    }
                }
            }
            i++
        }
        return null
    }

    private fun tidy(explanation: String): String =
        explanation.replace(Regex("""\s+"""), " ").trim().take(2000)
}
