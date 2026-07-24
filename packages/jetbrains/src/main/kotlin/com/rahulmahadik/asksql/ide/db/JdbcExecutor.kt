package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.BinaryPreview
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.ColumnKind
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.ResultColumn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
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

    // Serializes per-connection query work against ConnectionRegistry's concurrent-lease sharing where
    // the driver needs it: Oracle's arm-then-query pair, and DuckDB (its connection rejects concurrent
    // statements). Unbounded but tiny: one entry per Connection ever seen, not per query.
    private val perConnectionLocks = ConcurrentHashMap<Connection, Mutex>()

    /** Called by [ConnectionRegistry] right before it closes a [Connection] for good; without this, every connection this plugin ever opened pins a tiny (but permanent) entry here for the life of the IDE process. */
    fun forgetConnection(connection: Connection) {
        perConnectionLocks.remove(connection)
    }

    suspend fun execute(connection: Connection, sql: String, maxRows: Int, timeoutMs: Long, engine: EngineKind): AskSqlResultSet =
        withContext(Dispatchers.IO) {
          suspend fun onStatement(): AskSqlResultSet =
            // .use{} (not a manual close-on-error-only): a Statement left open after a successful
            // query leaks a server-side cursor, and on Oracle that exhausts open_cursors after a
            // few hundred queries.
            connection.createStatement().use { statement ->
                registerCancellation(statement)
                statement.queryTimeout = (timeoutMs / 1000).toInt().coerceAtLeast(1)
                // Fetch one extra row so truncation can be detected without a separate COUNT(*);
                // the (n+1)th row is discarded, never shown. Oracle's OCI prefetch buffers the
                // whole batch client-side per column, so a wide-column result set gets a tighter
                // ceiling than other engines to bound worst-case client memory.
                val fetchSizeCeiling = if (engine == EngineKind.ORACLE) 1_000 else 10_000
                statement.fetchSize = (maxRows + 1).coerceAtMost(fetchSizeCeiling)

                val startedNs = System.nanoTime()

                suspend fun runAndBuild(): AskSqlResultSet {
                    val rs = try {
                        if (engine == EngineKind.ORACLE) statement.execute("SET TRANSACTION READ ONLY")
                        statement.executeQuery(sql)
                    } catch (e: SQLException) {
                        throw AskSqlException(AskSqlErrorCode.DB_QUERY_ERROR, detail = e.message, cause = e)
                    }
                    return rs.use { resultSet ->
                        val meta = resultSet.metaData
                        val columns = (1..meta.columnCount).map { columnInfo(meta, it) }
                        val rows = mutableListOf<List<CellValue>>()
                        var truncated = false
                        var count = 0
                        while (resultSet.next()) {
                            if (count >= maxRows) {
                                truncated = true
                                break
                            }
                            rows += (1..meta.columnCount).map { readCell(resultSet, meta, it) }
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

                if (engine == EngineKind.ORACLE) {
                    // Oracle's read-only transaction covers only itself, not the session, so it's
                    // re-armed before every query with explicit transaction control (autocommit
                    // would leave it ambiguous whether the arm and the query share one transaction),
                    // toggled locally per call so other code sharing this connection is unaffected.
                    perConnectionLocks.getOrPut(connection) { Mutex() }.withLock {
                        val hadAutoCommit = connection.autoCommit
                        connection.autoCommit = false
                        try {
                            runAndBuild()
                        } finally {
                            try {
                                connection.commit()
                            } catch (e: SQLException) {
                                /* best-effort; the next arm fails loudly if the transaction truly didn't end */
                            }
                            connection.autoCommit = hadAutoCommit
                        }
                    }
                } else {
                    runAndBuild()
                }
            }

            // DuckDB's JDBC connection rejects concurrent statements (pgjdbc/mariadb serialize internally); serialize per connection.
            if (engine == EngineKind.DUCKDB) {
                perConnectionLocks.getOrPut(connection) { Mutex() }.withLock { onStatement() }
            } else {
                onStatement()
            }
        }

    /**
     * Cancelling the calling coroutine invokes [Statement.cancel], which most drivers honor by
     * aborting the query server-side rather than merely abandoning the client-side wait.
     */
    private suspend fun registerCancellation(statement: Statement) {
        val job = currentCoroutineContext().job
        job.invokeOnCompletion { cause ->
            if (cause is kotlinx.coroutines.CancellationException) {
                try { statement.cancel() } catch (_: SQLException) { /* best-effort */ }
            }
        }
    }

    // Types.BIT covers both a single-bit flag (Postgres bit(1), MySQL BIT(1)) and a multi-bit
    // string (bit(8), BIT(8)); the JDBC type code alone can't tell them apart. getBoolean() throws
    // on Postgres's multi-bit form and silently collapses MySQL's to true/false, losing the value.
    // Precision is the only signal that distinguishes them.
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

    private fun readCell(rs: java.sql.ResultSet, meta: ResultSetMetaData, index: Int): CellValue {
        val sqlType = meta.getColumnType(index)
        return when (sqlType) {
            Types.BIGINT, Types.DECIMAL, Types.NUMERIC -> {
                val text = rs.getString(index)
                if (rs.wasNull() || text == null) CellValue.Null else CellValue.ExactNumeric(text)
            }
            Types.INTEGER, Types.SMALLINT, Types.TINYINT, Types.FLOAT, Types.REAL, Types.DOUBLE -> {
                val value = rs.getDouble(index)
                if (rs.wasNull()) CellValue.Null else CellValue.Number(value)
            }
            Types.BOOLEAN -> {
                val value = rs.getBoolean(index)
                if (rs.wasNull()) CellValue.Null else CellValue.Boolean(value)
            }
            Types.BIT -> if (isSingleBit(meta, index)) {
                val value = rs.getBoolean(index)
                if (rs.wasNull()) CellValue.Null else CellValue.Boolean(value)
            } else {
                // A multi-bit value (e.g. bit(8)/BIT(8)): getBoolean() either throws (Postgres) or
                // silently collapses it to true/false (MySQL), losing the bit pattern; read as text.
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
                    CellValue.Binary(BinaryPreview(length, previewBytes.joinToString("") { "%02x".format(it) }))
                }
            }
            else -> {
                // Checking only `text == null` (not also wasNull()) is correct here: MariaDB's driver
                // returns the correct non-null string for a MySQL zero-value DATETIME
                // ("0000-00-00 00:00:00") from getString(), but wasNull() falsely reports true right
                // after, so trusting wasNull() would render a real value as a misleading "NULL".
                val text = rs.getString(index)
                if (text == null) CellValue.Null else CellValue.Text(text)
            }
        }
    }

    private fun binaryPreview(bytes: ByteArray): CellValue.Binary {
        val preview = bytes.copyOf(minOf(HEX_PREVIEW_BYTES, bytes.size))
        return CellValue.Binary(BinaryPreview(bytes.size.toLong(), preview.joinToString("") { "%02x".format(it) }))
    }
}
