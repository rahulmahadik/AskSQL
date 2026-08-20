package com.rahulmahadik.asksql.ide.db.introspect

import com.mongodb.client.MongoDatabase
import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.bson.Document
import org.bson.types.Decimal128
import org.bson.types.ObjectId
import java.util.Date
import java.util.concurrent.TimeUnit

/**
 * MongoDB has no catalog to query: schema is INFERRED by sampling documents (`$sample`). Doesn't
 * implement the `java.sql.Connection`-shaped [Introspector]; called directly from `MongoEnginePipeline`.
 */
object MongoIntrospector {

    private const val SAMPLE_SIZE = 200
    private const val SAMPLE_TIMEOUT_SECONDS = 15L

    /** Bounds concurrent per-collection sampling to the client's connection pool size (see MongoClientFactory). */
    private const val MAX_CONCURRENT_SAMPLES = 5

    /** Object/array flattening depth; deeper paths keep their own type but are not descended into. */
    private const val MAX_FLATTEN_DEPTH = 4

    /** Cap on distinct field paths recorded per collection. */
    private const val MAX_TRACKED_FIELDS = 500

    /** Samples every collection concurrently, bounded by [MAX_CONCURRENT_SAMPLES]. */
    suspend fun introspect(database: MongoDatabase): SchemaCatalog = coroutineScope {
        val collectionNames = database.listCollectionNames().toList()
        val semaphore = Semaphore(MAX_CONCURRENT_SAMPLES)
        val results = collectionNames.map { name ->
            async(Dispatchers.IO) {
                semaphore.withPermit {
                    try {
                        introspectCollection(database, name) to null
                    } catch (e: Exception) {
                        TableInfo(name = name, kind = TableKind.TABLE, columns = emptyList()) to
                            "Could not sample collection '$name': ${e.message}"
                    }
                }
            }
        }.awaitAll()
        SchemaCatalog(
            engine = EngineKind.MONGODB,
            tables = results.map { it.first },
            warnings = results.mapNotNull { it.second },
        )
    }

    private fun introspectCollection(database: MongoDatabase, name: String): TableInfo {
        val collection = database.getCollection(name)
        // maxTime bounds a pathological sample instead of hanging forever.
        val samples = collection.aggregate(listOf(Document("\$sample", Document("size", SAMPLE_SIZE))))
            .maxTime(SAMPLE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .into(mutableListOf())
        val rowEstimate = try {
            collection.estimatedDocumentCount()
        } catch (e: Exception) {
            null // optional estimate; never fail introspection over it
        }
        return TableInfo(
            name = name,
            kind = TableKind.TABLE,
            columns = inferColumns(samples),
            primaryKey = listOf("_id"),
            rowEstimate = rowEstimate,
            comment = if (samples.isEmpty()) "empty or inaccessible - schema could not be sampled" else null,
        )
    }

    /** Pure field-shape inference over already-sampled documents. */
    fun inferColumns(samples: List<Document>): List<ColumnInfo> {
        if (samples.isEmpty()) return emptyList()
        val stats = linkedMapOf<String, FieldStats>()
        val parentOf = linkedMapOf<String, String>()
        for (doc in samples) {
            walkDocument(doc, prefix = "", depth = 0, seenInThisDoc = mutableSetOf(), stats = stats, parentOf = parentOf)
        }
        val mapShaped = mapShapedPaths(stats, samples.size, parentOf)
        val dataKeys = mapShaped.values.flatten()
        return stats
            // A key of a map-shaped path is data, not a field: it must not become a column name.
            .filterKeys { path -> dataKeys.none { path == it || path.startsWith("$it.") } }
            .map { (path, s) -> s.toColumnInfo(path, samples.size, if (path == ROOT) null else mapShaped[path]?.size) }
    }

    /** A child field is part of the record's shape once it recurs in this share of the parent's documents. */
    private const val STABLE_CHILD_RATIO = 0.6

    /** A path segment that reads as a field name. One that does not is a key, which is data. */
    private val FIELD_SEGMENT = Regex("^[\\p{L}_][\\p{L}\\p{N}_]{0,39}$")

    /** Documents per child, averaged, below which the names look like keys rather than a record's fields. */
    private const val MIN_CHILD_REUSE = 2

    /** Below this many documents holding the parent, reuse says nothing, so only the key's shape decides. */
    private const val MIN_DOCS_FOR_REUSE = 3

    /** More children than a record plausibly has; past this, saturated names are still a map's keys. */
    private const val MAX_RECORD_FIELDS = 12

    /** Stands in for the document root, which is a parent with no column of its own. */
    private const val ROOT = "\u0000root"

    /**
     * Paths whose children are data rather than field names. `{ owed: { "ada@example.com": 120 } }` turns
     * every customer address into a column name, and a column NAME is never stripped by the data opt-in,
     * so those addresses reach the prompt on the default path. A record repeats its fields across
     * documents; a map does not. The judgement is per CHILD, so a summary field sitting beside the keys
     * keeps its name while the keys are dropped. Mirrors packages/mongodb/src/introspect.ts.
     */
    private fun mapShapedPaths(
        stats: Map<String, FieldStats>,
        totalSamples: Int,
        parentOf: Map<String, String>,
    ): Map<String, List<String>> {
        // A key may itself contain dots (an address is the common case), so the parent cannot be found by
        // splitting on the last one - that was the very shape this is meant to catch.
        val childrenOf = linkedMapOf<String, MutableList<String>>()
        for (path in stats.keys) {
            // A document can be a map at its ROOT - `{ "ada@example.com": 120 }` - and those paths have no
            // parent, so judging only parent/child pairs left every address as a top-level column name.
            val parent = parentOf[path].takeUnless { it.isNullOrEmpty() } ?: ROOT
            childrenOf.getOrPut(parent) { mutableListOf() } += path
        }
        val collapse = linkedMapOf<String, List<String>>()
        for ((parent, children) in childrenOf) {
            val parentDocs = if (parent == ROOT) totalSamples else stats[parent]?.presentCount ?: continue
            val needed = maxOf(MIN_CHILD_REUSE.toDouble(), parentDocs * STABLE_CHILD_RATIO)
            // A polymorphic record - an event payload, mutually exclusive payment fields - has no child
            // at 60% either, yet its names saturate: a few reused across many documents. Keys do not.
            // Only children that could be fields count towards saturation; dotted keys beside one real
            // field otherwise diluted the test and the field was deleted.
            val nameable = children.filter {
                FIELD_SEGMENT.matches(if (parent == ROOT) it else it.substring(parent.length + 1))
            }
            val occurrences = nameable.sumOf { stats[it]?.presentCount ?: 0 }
            // Capped as well as summed: the average alone only asks whether names recur twice each,
            // which any large map satisfies, and recurrence rises with the sample size.
            val keysRecur = nameable.size <= MAX_RECORD_FIELDS && occurrences >= nameable.size * MIN_CHILD_REUSE
            // Under a few documents a record and a map look identical by reuse, and dropping on that
            // evidence deleted the fields of any sub-document in a small sample. Shape still decides there.
            // At the ROOT, shape decides ALONE. A collection holding one document per integration is
            // ordinary and its field names do not recur, so judging the root by reuse returned a catalog
            // of just `_id`. A root keyed by data still goes: an address fails the shape test outright.
            val enoughEvidence = parent != ROOT && parentDocs >= MIN_DOCS_FOR_REUSE
            val data = children.filter { child ->
                val segment = if (parent == ROOT) child else child.substring(parent.length + 1)
                if (!FIELD_SEGMENT.matches(segment)) true
                else enoughEvidence && !keysRecur && (stats[child]?.presentCount ?: 0) < needed
            }
            if (data.isEmpty()) continue
            // A lone field-shaped child is a sparse field, not a map.
            val firstSegment = if (parent == ROOT) data[0] else data[0].substring(parent.length + 1)
            if (data.size < 2 && FIELD_SEGMENT.matches(firstSegment)) continue
            collapse[parent] = data
        }
        return collapse
    }

    private class FieldStats {
        var presentCount = 0
        val types = linkedSetOf<String>()
        var everAbsentOrNull = false
        val exampleValues = linkedSetOf<String>()
        /** True once a new distinct value arrives after the example cap, marking the recorded set incomplete. */
        var exceededExampleCap = false

        fun toColumnInfo(path: String, totalSamples: Int, mapKeyCount: Int? = null): ColumnInfo {
            val typeLabel = when {
                types.isEmpty() -> "unknown"
                types.size == 1 -> types.first()
                else -> "mixed(${types.sorted().joinToString("|")})"
            }
            val presenceRate = if (totalSamples == 0) 0 else presentCount * 100 / totalSamples
            return ColumnInfo(
                name = path,
                dbType = typeLabel,
                nullable = everAbsentOrNull || presentCount < totalSamples,
                comment = if (mapKeyCount != null) {
                    "map-shaped: its keys are data, not field names ($mapKeyCount distinct keys in " +
                        "$totalSamples sampled documents); read with \$objectToArray"
                } else {
                    "present in $presenceRate% of $totalSamples sampled documents"
                },
                sampledValues = if (!exceededExampleCap && exampleValues.isNotEmpty()) exampleValues.toList() else emptyList(),
            )
        }
    }

    private fun walkDocument(
        doc: Document,
        prefix: String,
        depth: Int,
        seenInThisDoc: MutableSet<String>,
        stats: MutableMap<String, FieldStats>,
        /** Path to its true parent, filled as the walk descends. The empty string means the root. */
        parentOf: MutableMap<String, String>,
    ) {
        for ((key, value) in doc) {
            val path = if (prefix.isEmpty()) key else "$prefix.$key"
            parentOf[path] = prefix
            recordField(path, value, depth, seenInThisDoc, stats, parentOf)
        }
    }

    private fun recordField(
        path: String,
        value: Any?,
        depth: Int,
        seenInThisDoc: MutableSet<String>,
        stats: MutableMap<String, FieldStats>,
        parentOf: MutableMap<String, String>,
    ) {
        // Documents keyed by arbitrary ids (a map-shaped collection) would otherwise grow one field per key.
        if (stats.size >= MAX_TRACKED_FIELDS && !stats.containsKey(path)) return
        val s = stats.getOrPut(path) { FieldStats() }
        if (seenInThisDoc.add(path)) s.presentCount++
        when {
            value == null -> s.everAbsentOrNull = true
            value is Document -> {
                s.types += "object"
                if (depth < MAX_FLATTEN_DEPTH) walkDocument(value, path, depth + 1, seenInThisDoc, stats, parentOf)
            }
            value is List<*> -> {
                val elementType = value.firstOrNull()?.let { bsonTypeName(it) } ?: "unknown"
                s.types += "array<$elementType>"
                // Descend only into arrays of sub-documents; scalar arrays have no per-field stats.
                if (depth < MAX_FLATTEN_DEPTH) {
                    value.filterIsInstance<Document>().take(5).forEach { walkDocument(it, path, depth + 1, seenInThisDoc, stats, parentOf) }
                }
            }
            else -> {
                s.types += bsonTypeName(value)
                val text = value.toString()
                if (!s.exampleValues.contains(text)) {
                    if (s.exampleValues.size < 20) s.exampleValues += text else s.exceededExampleCap = true
                }
            }
        }
    }

    private fun bsonTypeName(value: Any): String = when (value) {
        is String -> "string"
        is Int -> "int32"
        is Long -> "int64"
        is Double -> "double"
        is Decimal128 -> "decimal128"
        is Boolean -> "bool"
        is ObjectId -> "objectId"
        is Date -> "date"
        is Document -> "object"
        is List<*> -> "array"
        else -> value.javaClass.simpleName.lowercase()
    }
}
