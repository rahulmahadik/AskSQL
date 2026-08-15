package com.rahulmahadik.asksql.ide.engine

import org.bson.Document

/**
 * Mirrors packages/core/src/mongo/normalise.ts: meaning-preserving pipeline rewrites, applied before
 * the guard and re-validated by it. Each matches a single exact shape and returns null otherwise.
 */
object MongoNormalise {

    /** The single key of a one-key document, or null. */
    private fun soleKey(doc: Document): String? = if (doc.keys.size == 1) doc.keys.first() else null

    /** Counts how often `$name` appears anywhere in a value tree. */
    private fun referenceCount(node: Any?, ref: String): Int = when (node) {
        is String -> if (node == ref) 1 else 0
        is List<*> -> node.sumOf { referenceCount(it, ref) }
        is Document -> node.values.sumOf { referenceCount(it, ref) }
        is Map<*, *> -> node.values.sumOf { referenceCount(it, ref) }
        else -> 0
    }

    /**
     * Rewrites the `$addToSet` + `$size` distinct count, which the guard refuses because the array
     * must fit in one 16MB document, into a grouped count that spills to disk instead. Requires a
     * global group holding that one accumulator, with the array read exactly once.
     */
    fun rewriteDistinctCount(pipeline: List<Document>): List<Document>? {
        if (pipeline.size < 2) return null

        val groupStage = pipeline[0]
        val projectStage = pipeline[1]
        if (soleKey(groupStage) != "\$group") return null

        val group = groupStage["\$group"] as? Document ?: return null
        // A non-null _id means per-group distinct counts, which is a different question.
        if (!group.containsKey("_id") || group["_id"] != null) return null

        val accumulators = group.keys.filter { it != "_id" }
        if (accumulators.size != 1) return null
        val arrayName = accumulators.first()
        val accumulator = group[arrayName] as? Document ?: return null
        if (soleKey(accumulator) != "\$addToSet") return null

        // Only a plain field path: an expression could depend on the document in ways grouping changes.
        val field = accumulator["\$addToSet"] as? String ?: return null
        if (!field.startsWith("$") || field.startsWith("$$")) return null

        val projectKey = soleKey(projectStage)
        if (projectKey != "\$project" && projectKey != "\$addFields" && projectKey != "\$set") return null
        val projection = projectStage[projectKey] as? Document ?: return null

        val ref = "$$arrayName"
        // The array must be read exactly once, by the $size that turns it into a count.
        if (referenceCount(projection, ref) != 1) return null

        val outputs = projection.keys.filter { it != "_id" }
        if (outputs.size != 1) return null
        val countName = outputs.first()
        val sizeExpr = projection[countName] as? Document ?: return null
        if (soleKey(sizeExpr) != "\$size" || sizeExpr["\$size"] != ref) return null

        // Nothing after these two stages may mention the array either.
        val rest = pipeline.drop(2)
        if (referenceCount(rest, ref) != 0) return null

        // $addToSet skips a document whose field is missing; $group would collect those into a null
        // bucket and report one distinct value too many, so the match drops them first.
        return listOf(
            Document("\$match", Document(field.substring(1), Document("\$exists", true))),
            Document("\$group", Document("_id", field)),
            Document("\$count", countName),
        ) + rest
    }
}
