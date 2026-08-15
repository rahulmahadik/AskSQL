package com.rahulmahadik.asksql.ide.engine

import org.bson.Document

/**
 * Mirrors packages/core/src/mongo/stage-fields.ts: field references a pipeline cannot resolve. A
 * `$group` replaces the document, so afterwards only `_id` and the accumulator outputs exist.
 *
 * Only provable absences count: the catalog is sampled, so checking starts once a stage has narrowed
 * the document to a set computed here.
 */
object StageFields {

    data class UnknownStageField(
        val field: String,
        /** Zero-based index of the stage that references it. */
        val stage: Int,
        /** What the document does hold at that point, for the repair message. */
        val available: List<String>,
    )

    /** Stages whose effect on the document shape this object can reproduce exactly. */
    private val MODELLED = setOf(
        "\$group",
        "\$count",
        "\$project",
        "\$addFields",
        "\$set",
        "\$unset",
        "\$lookup",
        "\$unwind",
        "\$match",
        "\$sort",
        "\$limit",
        "\$skip",
        "\$sample",
    )

    /** The root of a field path: `$items.qty` is rooted at `items`, which is what a stage can drop. */
    private fun rootOf(ref: String): String? {
        if (!ref.startsWith("$") || ref.startsWith("$$")) return null
        val path = ref.substring(1)
        if (path.isEmpty()) return null
        val dot = path.indexOf('.')
        return if (dot == -1) path else path.substring(0, dot)
    }

    /** Every `"$field"` reference in expression position, in document order. */
    private fun fieldRefsIn(node: Any?, out: MutableList<String>) {
        // {$literal: "$x"} is the string "$x", not a reference to x - that is the point of $literal.
        if (node is Document && node.keys.size == 1 && node.containsKey("\$literal")) return
        when (node) {
            is String -> rootOf(node)?.let { out.add(it) }
            is List<*> -> node.forEach { fieldRefsIn(it, out) }
            is Document -> node.values.forEach { fieldRefsIn(it, out) }
            is Map<*, *> -> node.values.forEach { fieldRefsIn(it, out) }
            else -> {}
        }
    }

    private fun head(name: String): String = name.substringBefore('.')

    /** True when a `$project` selects fields rather than removing them. */
    private fun isInclusionProjection(spec: Document): Boolean {
        for ((k, v) in spec) {
            if (k == "_id") continue
            if (v == 0 || v == false) return false
            return true
        }
        // Only _id was named: {_id: 0} drops it and keeps everything else, which is an exclusion.
        return !(spec["_id"] == 0 || spec["_id"] == false)
    }

    /** Names a `$project` inclusion stage puts into the document. */
    private fun projectedNames(spec: Document): MutableSet<String> {
        val names = mutableSetOf<String>()
        for ((k, v) in spec) {
            if (k == "_id") {
                // `_id: 0` drops it; anything else keeps or recomputes it.
                if (v != 0 && v != false) names.add("_id")
                continue
            }
            if (v == 0 || v == false) continue
            names.add(head(k))
        }
        if (!spec.containsKey("_id")) names.add("_id")
        return names
    }

    data class MisquotedField(
        /** The path as written, without the leading `$`. */
        val raw: String,
        /** The catalog field it was meant to be. */
        val suggestion: String,
    )

    /** Quoting a segment the way SQL would: MongoDB reads the quotes as part of the name. */
    private fun unquoteSegment(segment: String): String {
        val pairs = listOf('`' to '`', '"' to '"', '\'' to '\'', '[' to ']')
        for ((open, close) in pairs) {
            if (segment.length > 1 && segment.first() == open && segment.last() == close) {
                return segment.substring(1, segment.length - 1)
            }
        }
        return segment
    }

    /** Full `$field.path` references anywhere in a pipeline, quoting and all. */
    private fun collectPaths(node: Any?, out: MutableList<String>) {
        when (node) {
            is String -> if (node.startsWith("$") && !node.startsWith("$$") && node.length > 1) out.add(node.substring(1))
            is List<*> -> node.forEach { collectPaths(it, out) }
            is Document -> node.values.forEach { collectPaths(it, out) }
            is Map<*, *> -> node.values.forEach { collectPaths(it, out) }
            else -> {}
        }
    }

    /**
     * A field reference carrying SQL quoting. `$`total amount`` names a field that does not exist,
     * so an aggregate over it returns 0 rather than failing. Reported only when the unquoted form is
     * a catalog field, which makes the mistake provable.
     */
    fun firstMisquotedField(pipeline: List<Document>, catalogFields: Set<String>): MisquotedField? {
        val refs = mutableListOf<String>()
        collectPaths(pipeline, refs)
        for (raw in refs) {
            if (raw in catalogFields) continue
            val unquoted = raw.split(".").joinToString(".") { unquoteSegment(it) }
            if (unquoted != raw && unquoted in catalogFields) {
                return MisquotedField(raw, unquoted)
            }
        }
        return null
    }

    /** The first field reference the pipeline provably cannot resolve, or null. */
    fun firstUnknownStageField(pipeline: List<Document>): UnknownStageField? {
        // Null until a stage narrows the document; before that the shape is sampled, so absence proves nothing.
        var available: MutableSet<String>? = null

        for (i in pipeline.indices) {
            val stage = pipeline[i]
            if (stage.keys.size != 1) return null
            val name = stage.keys.first()
            val spec = stage[name]

            // $replaceRoot, $facet, $unionWith and anything unrecognised: sub-pipelines carry their own scope.
            if (name !in MODELLED) return null

            val current = available
            if (current != null) {
                val refs = mutableListOf<String>()
                if (name == "\$lookup" && spec is Document) {
                    // A sub-pipeline reads the foreign collection; only localField and `let` come from this one.
                    fieldRefsIn(spec["localField"], refs)
                    fieldRefsIn(spec["let"], refs)
                } else {
                    fieldRefsIn(spec, refs)
                }
                for (ref in refs) {
                    if (ref !in current) {
                        return UnknownStageField(ref, i, current.sorted())
                    }
                }
            }

            when (name) {
                "\$group" -> {
                    if (spec !is Document) return null
                    available = spec.keys.toMutableSet()
                }
                "\$count" -> {
                    if (spec !is String) return null
                    available = mutableSetOf(spec)
                }
                "\$project" -> {
                    if (spec !is Document) return null
                    if (!isInclusionProjection(spec)) {
                        // An exclusion projection only removes names, narrowing a set already known.
                        current?.removeAll(spec.keys.map { head(it) }.toSet())
                    } else {
                        available = projectedNames(spec)
                    }
                }
                "\$addFields", "\$set" -> {
                    if (spec !is Document) return null
                    current?.addAll(spec.keys.map { head(it) })
                }
                "\$unset" -> {
                    val names = when (spec) {
                        is String -> listOf(spec)
                        is List<*> -> spec.filterIsInstance<String>()
                        else -> return null
                    }
                    current?.removeAll(names.map { head(it) }.toSet())
                }
                "\$unwind" -> {
                    // includeArrayIndex adds its name to every document the stage emits.
                    val idx = (spec as? Document)?.get("includeArrayIndex") as? String
                    if (idx != null) current?.add(head(idx))
                }
                "\$lookup" -> {
                    if (spec !is Document) return null
                    val asField = spec["as"] as? String ?: return null
                    current?.add(head(asField))
                }
                // $unwind replaces an array with its element; the field itself remains. $match,
                // $sort, $limit, $skip and $sample do not change the shape.
                else -> {}
            }
        }
        return null
    }
}
