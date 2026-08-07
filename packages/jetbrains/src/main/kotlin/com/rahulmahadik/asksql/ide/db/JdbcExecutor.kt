package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.BinaryPreview
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.ColumnKind
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.ResultColumn
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.sql.Connection
import java.sql.ResultSetMetaData
import java.sql.SQLException
import java.sql.Statement
import java.sql.Types
import java.util.concurrent.ConcurrentHashMap

/**
 * Executes a guard-verified statement and marshals the `ResultSet` into [AskSqlResultSet]. BIGINT/DECIMAL read via
 * `getString`, never `getDouble` (silent rounding); binary columns become a `{bytes, hexPreview}` marker, never a full byte array.
 */
object JdbcExecutor {

    private const val HEX_PREVIEW_BYTES = 32

    // Serializes per-connection work where the driver needs it: Oracle's arm-then-query pair, and DuckDB, which rejects concurrent statements.
    private val perConnectionLocks = ConcurrentHashMap<Connection, Mutex>()

    /** Drops [connection]'s lock entry; called by [ConnectionRegistry] right before it closes the connection for good. */
    fun forgetConnection(connection: Connection) {
        perConnectionLocks.remove(connection)
    }

    /** Runs [action] under the per-connection lock; every statement on a DuckDB connection must go through this, including [ConnectionRegistry]'s validity probe. */
    suspend fun <T> withConnectionLock(connection: Connection, action: suspend () -> T): T =
        perConnectionLocks.computeIfAbsent(connection) { Mutex() }.withLock { action() }

    suspend fun execute(connection: Connection, sql: String, maxRows: Int, timeoutMs: Long, engine: EngineKind): AskSqlResultSet =
        withContext(Dispatchers.IO) {
          suspend fun onStatement(): AskSqlResultSet =
            // A Statement left open leaks a server-side cursor; on Oracle that exhausts open_cursors.
            connection.createStatement().use { statement ->
                statement.queryTimeout = (timeoutMs / 1000).toInt().coerceAtLeast(1)
                // Fetches one extra row, so truncation is detectable without a separate COUNT(*).
                // Oracle's OCI prefetch buffers the whole batch client-side per column, hence its tighter ceiling.
                val fetchSizeCeiling = if (engine == EngineKind.ORACLE) 1_000 else 10_000
                statement.fetchSize = (maxRows + 1).coerceAtMost(fetchSizeCeiling)

                val startedNs = System.nanoTime()

                suspend fun runAndBuild(): AskSqlResultSet {
                    val rs = try {
                        if (engine == EngineKind.ORACLE) statement.execute("SET TRANSACTION READ ONLY")
                        statement.executeQuery(sql)
                    } catch (e: SQLException) {
                        // A statement cancelled by Stop fails with a driver error; the cancellation is the outcome to report.
                        currentCoroutineContext().ensureActive()
                        throw AskSqlException(AskSqlErrorCode.DB_QUERY_ERROR, detail = e.message, cause = e)
                    }
                    return rs.use { resultSet ->
                        val meta = resultSet.metaData
                        val columns = (1..meta.columnCount).map { columnInfo(meta, it) }
                        // Types are loop-invariant except on SQLite, whose driver reports the
                        // current row's storage class and so must be read per row.
                        val perRowTypes = engine == EngineKind.SQLITE
                        val columnTypes = if (perRowTypes) IntArray(0) else IntArray(meta.columnCount) { meta.getColumnType(it + 1) }
                        val singleBit = if (perRowTypes) BooleanArray(0) else BooleanArray(meta.columnCount) {
                            columnTypes[it] == Types.BIT && isSingleBit(meta, it + 1)
                        }
                        val rows = mutableListOf<List<CellValue>>()
                        var truncated = false
                        var count = 0
                        while (resultSet.next()) {
                            if (count >= maxRows) {
                                truncated = true
                                break
                            }
                            rows += (1..meta.columnCount).map {
                                val sqlType = if (perRowTypes) meta.getColumnType(it) else columnTypes[it - 1]
                                val bit = if (perRowTypes) sqlType == Types.BIT && isSingleBit(meta, it) else singleBit[it - 1]
                                readCell(resultSet, sqlType, bit, it)
                            }
                            count++
                        }
                        AskSqlResultSet(
                            columns = columns,
                            rows = rows,
                            rowCount = rows.size,
                            truncated = truncated,
                            durationMs = (System.nanoTime() - startedNs) / 1_000_000,
                        )
                    }
                }

                withStatementCancellation(statement) {
                    if (engine == EngineKind.ORACLE) {
                        // Oracle's read-only transaction covers only itself, not the session, so it is re-armed per query with autocommit off.
                        withConnectionLock(connection) {
                            val hadAutoCommit = connection.autoCommit
                            connection.autoCommit = false
                            try {
                                runAndBuild()
                            } finally {
                                try {
                                    connection.commit()
                                } catch (e: SQLException) {
                                    /* best-effort */
                                }
                                connection.autoCommit = hadAutoCommit
                            }
                        }
                    } else {
                        runAndBuild()
                    }
                }
            }

            // DuckDB's JDBC connection rejects concurrent statements (pgjdbc/mariadb serialize internally); serialize per connection.
            if (engine == EngineKind.DUCKDB) {
                withConnectionLock(connection) { onStatement() }
            } else {
                onStatement()
            }
        }

    /** Runs [block] alongside a watcher that calls [Statement.cancel] from its own thread as soon as the caller's coroutine is cancelled. */
    private suspend fun <T> withStatementCancellation(statement: Statement, block: suspend () -> T): T = coroutineScope {
        val query = coroutineContext.job
        // Starts undispatched, so the watcher is already awaiting cancellation before the blocking call below begins.
        val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                if (query.isCancelled) {
                    try { statement.cancel() } catch (e: Exception) { /* best-effort */ }
                }
            }
        }
        try {
            block()
        } finally {
            watcher.cancel()
        }
    }

    // Types.BIT covers both a single-bit flag (bit(1)/BIT(1)) and a multi-bit string (bit(8)/BIT(8)); precision is the only signal that tells them apart.
    private fun isSingleBit(meta: ResultSetMetaData, index: Int): Boolean =
        try { meta.getPrecision(index) <= 1 } catch (e: Exception) { true }

    private fun columnInfo(meta: ResultSetMetaData, index: Int): ResultColumn {
        val sqlType = meta.getColumnType(index)
        val kind = when (sqlType) {
            Types.BIGINT -> ColumnKind.BIGINT
            Types.DECIMAL, Types.NUMERIC -> ColumnKind.DECIMAL
            Types.INTEGER, Types.SMALLINT, Types.TINYINT, Types.FLOAT, Types.REAL, Types.DOUBLE -> ColumnKind.NUMBER
            Types.BOOLEAN -> ColumnKind.BOOLEAN
            Types.BIT -> if (isSingleBit(meta, index)) ColumnKind.BOOLEAN else ColumnKind.TEXT
            Types.TIMESTAMP, Types.TIMESTAMP_WITH_TIMEZONE -> ColumnKind.TIMESTAMP
            Types.DATE -> ColumnKind.DATE
            Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY, Types.BLOB -> ColumnKind.BINARY
            Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR, Types.CLOB -> ColumnKind.TEXT
            else -> ColumnKind.UNKNOWN
        }
        return ResultColumn(name = meta.getColumnLabel(index), dbType = meta.getColumnTypeName(index), kind = kind)
    }

    private fun readCell(rs: java.sql.ResultSet, sqlType: Int, singleBit: Boolean, index: Int): CellValue {
        return when (sqlType) {
            Types.BIGINT, Types.DECIMAL, Types.NUMERIC, Types.INTEGER, Types.SMALLINT, Types.TINYINT -> {
                val text = rs.getString(index)
                if (rs.wasNull() || text == null) CellValue.Null else CellValue.ExactNumeric(text)
            }
            Types.FLOAT, Types.REAL, Types.DOUBLE -> {
                val value = rs.getDouble(index)
                if (rs.wasNull()) CellValue.Null else CellValue.Number(value)
            }
            Types.BOOLEAN -> {
                val value = rs.getBoolean(index)
                if (rs.wasNull()) CellValue.Null else CellValue.Boolean(value)
            }
            Types.BIT -> if (singleBit) {
                val value = rs.getBoolean(index)
                if (rs.wasNull()) CellValue.Null else CellValue.Boolean(value)
            } else {
                // A multi-bit value: getBoolean() throws (Postgres) or collapses it to true/false (MySQL), so it is read as text.
                val text = rs.getString(index)
                if (rs.wasNull() || text == null) CellValue.Null else CellValue.Text(text)
            }
            Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY -> {
                val bytes = rs.getBytes(index)
                if (rs.wasNull() || bytes == null) CellValue.Null else binaryPreview(bytes)
            }
            Types.BLOB -> {
                val blob = rs.getBlob(index)
                if (rs.wasNull() || blob == null) {
                    CellValue.Null
                } else {
                    val length = blob.length()
                    val previewBytes = blob.getBytes(1, minOf(HEX_PREVIEW_BYTES.toLong(), length).toInt())
                    CellValue.Binary(BinaryPreview(length, toHex(previewBytes)))
                }
            }
            else -> {
                // wasNull() is not consulted: MariaDB's driver reports true after a valid getString() of a MySQL zero-value DATETIME ("0000-00-00 00:00:00").
                val text = rs.getString(index)
                if (text == null) CellValue.Null else CellValue.Text(text)
            }
        }
    }

    private fun binaryPreview(bytes: ByteArray): CellValue.Binary {
        val preview = bytes.copyOf(minOf(HEX_PREVIEW_BYTES, bytes.size))
        return CellValue.Binary(BinaryPreview(bytes.size.toLong(), toHex(preview)))
    }

    private val hexDigits = "0123456789abcdef".toCharArray()

    /** Lookup-table hex: `"%02x".format(b)` builds a Formatter per byte, which is per-cell hot-path cost. */
    private fun toHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(hexDigits[v ushr 4]).append(hexDigits[v and 0xf])
        }
        return sb.toString()
    }
}
