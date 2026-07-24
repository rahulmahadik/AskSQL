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

    /** Bounds concurrent per-collection sampling to the client's own connection pool size (see MongoClientFactory); more concurrency than that would just queue on checkout, not go any faster. */
    private const val MAX_CONCURRENT_SAMPLES = 5

    /** Object/array flattening depth; dotted paths beyond this are not descended into (their own type is still recorded, just not their children). */
    private const val MAX_FLATTEN_DEPTH = 4

    /** Cap on distinct field paths per collection; far above any real schema, low enough to bound a map-shaped one. */
    private const val MAX_TRACKED_FIELDS = 500

    /** A schema with hundreds of collections would take minutes to introspect one at a time; sampling runs concurrently, bounded so it doesn't starve the connection pool. */
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

    /** Pure field-shape inference over already-sampled documents, split out so `MongoIntrospectorTest` can cover it without a live MongoDB. */
    fun inferColumns(samples: List<Document>): List<ColumnInfo> {
        if (samples.isEmpty()) return emptyList()
        val stats = linkedMapOf<String, FieldStats>()
        for (doc in samples) {
            walkDocument(doc, prefix = "", depth = 0, seenInThisDoc = mutableSetOf(), stats = stats)
        }
        return stats.map { (path, s) -> s.toColumnInfo(path, samples.size) }
    }

    private class FieldStats {
        var presentCount = 0
        val types = linkedSetOf<String>()
        var everAbsentOrNull = false
        val exampleValues = linkedSetOf<String>()
        /** True once a genuinely NEW distinct value arrives after the cap; distinct from merely having capped insertion, so a truly high-cardinality field is never reported as if its first 20 values were the complete set. */
        var exceededExampleCap = false

        fun toColumnInfo(path: String, totalSamples: Int): ColumnInfo {
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
                comment = "present in $presenceRate% of $totalSamples sampled documents",
                sampledValues = if (!exceededExampleCap && exampleValues.isNotEmpty()) exampleValues.toList() else emptyList(),
            )
        }
    }

    private fun walkDocument(doc: Document, prefix: String, depth: Int, seenInThisDoc: MutableSet<String>, stats: MutableMap<String, FieldStats>) {
        for ((key, value) in doc) {
            val path = if (prefix.isEmpty()) key else "$prefix.$key"
            recordField(path, value, depth, seenInThisDoc, stats)
        }
    }

    private fun recordField(path: String, value: Any?, depth: Int, seenInThisDoc: MutableSet<String>, stats: MutableMap<String, FieldStats>) {
        // Documents keyed by arbitrary ids (a map-shaped collection) would otherwise grow one field per key.
        if (stats.size >= MAX_TRACKED_FIELDS && !stats.containsKey(path)) return
        val s = stats.getOrPut(path) { FieldStats() }
        if (seenInThisDoc.add(path)) s.presentCount++
        when {
            value == null -> s.everAbsentOrNull = true
            value is Document -> {
                s.types += "object"
                if (depth < MAX_FLATTEN_DEPTH) walkDocument(value, path, depth + 1, seenInThisDoc, stats)
            }
            value is List<*> -> {
                val elementType = value.firstOrNull()?.let { bsonTypeName(it) } ?: "unknown"
                s.types += "array<$elementType>"
                // Descend only into arrays of sub-documents; scalar arrays have no per-field stats.
                if (depth < MAX_FLATTEN_DEPTH) {
                    value.filterIsInstance<Document>().take(5).forEach { walkDocument(it, path, depth + 1, seenInThisDoc, stats) }
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
