package com.rahulmahadik.asksql.ide.model

enum class ColumnKind {
    TEXT, NUMBER, BIGINT, DECIMAL, BOOLEAN, TIMESTAMP, DATE, JSON, BINARY, UNKNOWN,
}

data class ResultColumn(val name: String, val dbType: String? = null, val kind: ColumnKind)

/**
 * Size + hex preview only. Binary payloads are never materialized as full
 * byte arrays in the UI/history layer.
 */
data class BinaryPreview(val bytes: Long, val hexPreview: String)

/**
 * JSON-safe cell values. BIGINT/DECIMAL/NUMERIC travel as strings, not a JVM
 * `Long`/`Double`, to avoid silently rounding a DECIMAL through a `Double`. See [com.rahulmahadik.asksql.ide.db.JdbcExecutor].
 */
sealed interface CellValue {
    data object Null : CellValue
    data class Text(val value: String) : CellValue
    data class Number(val value: Double) : CellValue
    data class Boolean(val value: kotlin.Boolean) : CellValue
    /** BIGINT/DECIMAL/NUMERIC, string-encoded, exact. */
    data class ExactNumeric(val value: String) : CellValue
    data class Binary(val preview: BinaryPreview) : CellValue
}

data class AskSqlResultSet(
    val columns: List<ResultColumn>,
    val rows: List<List<CellValue>>,
    val rowCount: Int,
    /** True when maxRows clipped the result. */
    val truncated: Boolean,
    val durationMs: Long,
    val warnings: List<String> = emptyList(),
)
