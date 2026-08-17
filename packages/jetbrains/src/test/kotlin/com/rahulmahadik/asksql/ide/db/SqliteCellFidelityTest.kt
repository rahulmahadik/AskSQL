package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.ui.displayString
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.sql.DriverManager

/**
 * A Room primary key is a Kotlin Long, so an id past 2^53 is ordinary. It survives only because
 * [JdbcExecutor] reads the column type per ROW on SQLite: the driver reports the current row's storage
 * class, answering INTEGER for a small value and BIGINT for a large one. Read once per result set, a
 * column whose first row is small would round every later row. Nothing else covers that.
 */
class SqliteCellFidelityTest {

    private fun connect() = DriverManager.getConnection("jdbc:sqlite::memory:").also {
        Class.forName("org.sqlite.JDBC")
    }

    /** 2^53 + 1: the first integer a double cannot represent. */
    private val pastDoubleRange = "9007199254740993"

    private suspend fun read(sql: String, prepare: String) = connect().let { c ->
        c.createStatement().use { st -> prepare.split(";\n").forEach { st.execute(it) } }
        JdbcExecutor.execute(c, sql, maxRows = 10, timeoutMs = 5000, EngineKind.SQLITE).also { c.close() }
    }

    @Test
    fun `an id past a double's range is exact whatever type the column declares`() = runTest {
        // Room writes INTEGER; a hand-rolled schema may write BIGINT, INT, or no type at all.
        val result = read(
            "SELECT * FROM t",
            "CREATE TABLE t (declared_integer INTEGER, declared_bigint BIGINT, declared_int INT, untyped);\n" +
                "INSERT INTO t VALUES ($pastDoubleRange, $pastDoubleRange, $pastDoubleRange, $pastDoubleRange)",
        )
        for ((i, cell) in result.rows.first().withIndex()) {
            assertEquals(result.columns[i].name, pastDoubleRange, displayString(cell))
        }
    }

    @Test
    fun `a column holding both a small id and a huge one keeps every digit of both`() = runTest {
        // The case a per-result-set read would corrupt: the first row decides the type for the rest.
        val result = read("SELECT id FROM t ORDER BY id", "CREATE TABLE t (id INTEGER);\nINSERT INTO t VALUES (5), ($pastDoubleRange)")
        assertEquals(listOf("5", pastDoubleRange), result.rows.map { displayString(it.first()) })
    }

    @Test
    fun `the same column read in the other order is still exact`() = runTest {
        val result = read("SELECT id FROM t ORDER BY id DESC", "CREATE TABLE t (id INTEGER);\nINSERT INTO t VALUES (5), ($pastDoubleRange)")
        assertEquals(listOf(pastDoubleRange, "5"), result.rows.map { displayString(it.first()) })
    }

    @Test
    fun `a Room boolean and an epoch timestamp read as the app wrote them`() = runTest {
        // Room has no boolean and no date type: 0/1 and epoch millis are what an Android schema holds.
        val result = read(
            "SELECT is_active, created_at FROM users",
            "CREATE TABLE users (id INTEGER PRIMARY KEY, is_active INTEGER, created_at INTEGER);\n" +
                "INSERT INTO users VALUES (1, 1, 1755300000000)",
        )
        val row = result.rows.first()
        // Not "1.0": an integer must never gain a decimal the database did not have.
        assertEquals("1", displayString(row[0]))
        assertEquals("1755300000000", displayString(row[1]))
    }

    @Test
    fun `a BLOB column does not take the whole result set down with it`() = runTest {
        // A Room ByteArray field is a BLOB column. SQLite's driver reports Types.BLOB and implements
        // none of java.sql.Blob, so reading it that way threw and every row of the query was lost,
        // reported to the user as "the database didn't accept that query".
        val result = read(
            "SELECT id, thumb FROM photo ORDER BY id",
            "CREATE TABLE photo (id INTEGER PRIMARY KEY, thumb BLOB);\n" +
                "INSERT INTO photo VALUES (1, x'89504E470D0A1A0A'), (2, NULL)",
        )
        assertEquals(2, result.rows.size)
        val preview = result.rows[0][1]
        assertTrue("expected a binary preview, got $preview", preview is CellValue.Binary)
        assertEquals(8L, (preview as CellValue.Binary).preview.bytes)
        // A NULL blob is still a NULL, not an empty preview.
        assertTrue(result.rows[1][1] is CellValue.Null)
    }

    @Test
    fun `a NULL in an integer column stays distinguishable from zero`() = runTest {
        val result = read(
            "SELECT n FROM t ORDER BY rowid",
            "CREATE TABLE t (n INTEGER);\nINSERT INTO t VALUES (0), (NULL)",
        )
        assertEquals("0", displayString(result.rows[0].first()))
        assertTrue(result.rows[1].first() is CellValue.Null)
    }
}
