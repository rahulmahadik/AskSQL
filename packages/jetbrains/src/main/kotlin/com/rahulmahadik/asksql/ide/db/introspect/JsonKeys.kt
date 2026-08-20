package com.rahulmahadik.asksql.ide.db.introspect

/**
 * Just enough JSON to read a column's shape, without adding a parser dependency to the plugin. Shared by
 * every introspector so the two implementations of the hint cannot disagree; the TypeScript side uses
 * JSON.parse, and HintParityTest holds them to the same vectors.
 */
object JsonKeys {

    /**
     * Top-level keys of a JSON object, or null if the text is not one. Nested objects and arrays are
     * skipped over rather than descended into.
     */
    fun topLevel(text: String): List<String>? {
        if (!text.startsWith("{")) return null
        val keys = mutableListOf<String>()
        var i = 1
        var depth = 0
        var inString = false
        var escaped = false
        // A string only becomes a key in key POSITION. Without this, `{env: "prod"}` recorded the VALUE
        // "prod" as a key: relaxed config in a TEXT column was described with keys no document has.
        var expectKey = true
        var sawContent = false
        var pendingKey: String? = null
        val buf = StringBuilder()
        while (i < text.length) {
            val ch = text[i]
            when {
                // Keep the backslash: dropping it turned "café" into the key "caf00e9", a name no
                // document has. A key carrying one fails the field-name test, so the column is rejected -
                // which is what JSON.parse plus that test do on the TypeScript side.
                escaped -> {
                    escaped = false
                    if (inString) buf.append('\\')
                }
                ch == '\\' && inString -> escaped = true
                ch == '"' -> {
                    if (inString) {
                        if (depth == 0 && expectKey) pendingKey = buf.toString()
                        buf.setLength(0)
                    }
                    inString = !inString
                    sawContent = true
                }
                inString -> buf.append(ch)
                ch == '{' || ch == '[' -> { depth++; sawContent = true }
                ch == '}' || ch == ']' -> {
                    if (depth == 0) {
                        // Only a closing brace ends an object, only when nothing follows it, and only
                        // when the content actually parsed into keys. `{name=Ada, city=Pune}` (a Java
                        // Map.toString) and `{"a":1} extra` were both being called JSON objects.
                        val terminated = ch == '}' && text.substring(i + 1).isBlank()
                        return if (terminated && (keys.isNotEmpty() || !sawContent)) keys else null
                    }
                    depth--
                }
                ch == ':' && depth == 0 -> {
                    val key = pendingKey ?: return null // an unquoted key is not JSON
                    keys += key
                    pendingKey = null
                    expectKey = false
                }
                ch == ',' && depth == 0 -> {
                    expectKey = true
                    pendingKey = null
                }
                !ch.isWhitespace() -> sawContent = true
            }
            i++
        }
        // Reaching the end without closing the top-level object means the text is not JSON at all.
        return null
    }

    /** A JSON number exactly as the grammar defines it; toDoubleOrNull also accepts 08, 1d and Infinity. */
    private val JSON_NUMBER = Regex("""^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$""")

    /** "number", "string", "empty" for [], "mixed" for anything else, null if the text is not an array. */
    fun arrayElement(text: String): String? {
        val trimmed = text.trim()
        if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null
        // Tokenised with the same string state the object scanner uses: splitting on raw commas broke
        // ["Smith, John"] into two malformed halves, and a brace inside a string read as nesting.
        val tokens = mutableListOf<String>()
        val buf = StringBuilder()
        var depth = 0
        var inString = false
        var escaped = false
        for (i in 1 until trimmed.length - 1) {
            val ch = trimmed[i]
            when {
                escaped -> { escaped = false; buf.append(ch) }
                ch == '\\' && inString -> { escaped = true; buf.append(ch) }
                ch == '"' -> { inString = !inString; buf.append(ch) }
                inString -> buf.append(ch)
                ch == '{' || ch == '[' -> { depth++; buf.append(ch) }
                ch == '}' || ch == ']' -> { depth--; buf.append(ch) }
                ch == ',' && depth == 0 -> { tokens += buf.toString(); buf.setLength(0) }
                else -> buf.append(ch)
            }
        }
        if (inString || depth != 0) return null
        if (buf.isNotBlank() || tokens.isNotEmpty()) tokens += buf.toString()
        val values = tokens.map { it.trim() }.filter { it.isNotEmpty() }
        if (values.isEmpty()) return "empty"
        var kind: String? = null
        for (v in values) {
            val k = when {
                v.length >= 2 && v.startsWith("\"") && v.endsWith("\"") -> "string"
                JSON_NUMBER.matches(v) -> "number"
                else -> return "mixed"
            }
            if (kind != null && kind != k) return "mixed"
            kind = k
        }
        return kind
    }
}
