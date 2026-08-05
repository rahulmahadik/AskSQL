package com.rahulmahadik.asksql.ide.db

import com.mongodb.client.MongoDatabase
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.BinaryPreview
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.ColumnKind
import com.rahulmahadik.asksql.ide.model.ResultColumn
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import org.bson.Document
import org.bson.types.Binary
import org.bson.types.Decimal128
import org.bson.types.ObjectId
import java.util.Date
import java.util.concurrent.TimeUnit

/**
 * Runs a guard-verified pipeline and marshals BSON into [AskSqlResultSet] (the Mongo [JdbcExecutor]).
 * Columns are the union of fields across all documents; a missing field renders as [CellValue.Null].
 */
object MongoQueryExecutor {

    private const val HEX_PREVIEW_BYTES = 32
    private val gson = Gson()

    suspend fun execute(database: MongoDatabase, collectionName: String, pipeline: List<Document>, maxRows: Int, timeoutMs: Long): AskSqlResultSet =
        withContext(Dispatchers.IO) {
            val started = System.nanoTime()
            val collection = database.getCollection(collectionName)
            // Appended AFTER the guard's own $limit: sequential $limits compose, so the smaller wins.
            // The one extra document is how truncation is detected without a second count query.
            val effectivePipeline = pipeline + Document("\$limit", (maxRows + 1).toLong())

            val docs = mutableListOf<Document>()
            var truncated = false
            val job = currentCoroutineContext().job
            try {
                collection.aggregate(effectivePipeline)
                    .maxTime(timeoutMs, TimeUnit.MILLISECONDS)
                    .batchSize((maxRows + 1).coerceAtMost(10_000))
                    .iterator().use { cursor ->
                        // Closing the cursor from the cancellation hook aborts the blocking batch fetch.
                        job.invokeOnCompletion { cause ->
                            if (cause is kotlinx.coroutines.CancellationException) {
                                try { cursor.close() } catch (_: Exception) { /* best-effort */ }
                            }
                        }
                        while (cursor.hasNext()) {
                            val doc = cursor.next()
                            if (docs.size >= maxRows) {
                                truncated = true
                                break
                            }
                            docs += doc
                        }
                    }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e // a user-initiated cancel, not a query failure
            } catch (e: Exception) {
                job.ensureActive() // a cursor closed by the hook surfaces as IllegalStateException/MongoException; report the cancel, not a fake DB error
                throw AskSqlException(AskSqlErrorCode.DB_QUERY_ERROR, detail = e.message, cause = e)
            }

            val columnNames = linkedSetOf<String>()
            docs.forEach { columnNames += it.keys }

            val columnKinds = mutableMapOf<String, ColumnKind>()
            for (doc in docs) {
                for (key in columnNames) {
                    if (columnKinds.containsKey(key)) continue
                    doc[key]?.let { columnKinds[key] = columnKind(it) }
                }
            }

            val columns = columnNames.map { ResultColumn(name = it, kind = columnKinds[it] ?: ColumnKind.UNKNOWN) }
            val rows = docs.map { doc -> columnNames.map { key -> cellValue(doc[key]) } }

            AskSqlResultSet(
                columns = columns,
                rows = rows,
                rowCount = rows.size,
                truncated = truncated,
                durationMs = (System.nanoTime() - started) / 1_000_000,
            )
        }

    /** Non-private for direct unit testing (see `MongoQueryExecutorTest`); pure and DB-free, unlike [execute]. */
    fun columnKind(value: Any): ColumnKind = when (value) {
        is String -> ColumnKind.TEXT
        is Int -> ColumnKind.NUMBER
        is Long -> ColumnKind.BIGINT
        is Double -> ColumnKind.NUMBER
        is Decimal128 -> ColumnKind.DECIMAL
        is Boolean -> ColumnKind.BOOLEAN
        is Date -> ColumnKind.TIMESTAMP
        is ObjectId -> ColumnKind.TEXT
        is Binary -> ColumnKind.BINARY
        is Document, is List<*> -> ColumnKind.JSON
        else -> ColumnKind.UNKNOWN
    }

    /** Numeric-fidelity rule (shared with [JdbcExecutor]): int64/Decimal128 travel as exact strings, never a lossy JVM Double. Non-private for direct unit testing. */
    fun cellValue(value: Any?): CellValue = when (value) {
        null -> CellValue.Null
        is String -> CellValue.Text(value)
        is ObjectId -> CellValue.Text(value.toHexString())
        is Int -> CellValue.Number(value.toDouble())
        is Long -> CellValue.ExactNumeric(value.toString())
        is Double -> CellValue.Number(value)
        is Decimal128 -> CellValue.ExactNumeric(value.toString())
        is Boolean -> CellValue.Boolean(value)
        is Date -> CellValue.Text(value.toInstant().toString())
        is Binary -> binaryPreview(value.data)
        is Document, is List<*> -> CellValue.Text(gson.toJson(toPlainJson(value)))
        else -> CellValue.Text(value.toString())
    }

    private fun binaryPreview(bytes: ByteArray): CellValue.Binary {
        val preview = bytes.copyOf(minOf(HEX_PREVIEW_BYTES, bytes.size))
        return CellValue.Binary(BinaryPreview(bytes.size.toLong(), preview.joinToString("") { "%02x".format(it) }))
    }

    /** Recursively strips BSON-specific types down to plain JSON-serializable values (Gson has no native codec for ObjectId/Decimal128/Binary/Document). */
    private fun toPlainJson(value: Any?): Any? = when (value) {
        null -> null
        is Document -> value.mapValues { toPlainJson(it.value) }
        is List<*> -> value.map { toPlainJson(it) }
        is ObjectId -> value.toHexString()
        is Decimal128 -> value.toString()
        is Date -> value.toInstant().toString()
        is Binary -> "0x" + value.data.joinToString("") { "%02x".format(it) }
        else -> value
    }
}
