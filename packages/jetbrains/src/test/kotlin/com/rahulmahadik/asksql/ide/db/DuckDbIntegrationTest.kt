package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.db.introspect.Introspectors
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.io.File
import java.util.Properties

/**
 * Proves the lazy-downloaded DuckDB driver path end to end: file-backed (read-only enforcement in
 * [JdbcConnectionFactory] only applies to file-backed DuckDB), real introspection, real write rejection.
 */
@Category(IntegrationTest::class)
class DuckDbIntegrationTest {

    private lateinit var dbFile: File

    @Before
    fun seedDatabase() = runTest {
        dbFile = File.createTempFile("asksql-duckdb-test", ".duckdb")
        dbFile.delete() // DuckDB creates the file itself; a pre-existing empty file confuses it
        // Seeds through the same lazy-downloaded driver production code uses, not a direct classpath
        // reference: duckdb_jdbc is deliberately absent from the compile classpath (see DriverProvisioner).
        val driver = DriverProvisioner.duckDbDriver()
        driver.connect("jdbc:duckdb:${dbFile.path}", Properties())!!.use { connection ->
            connection.createStatement().use { st ->
                st.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL)")
                st.execute("INSERT INTO customers VALUES (1, 'Ava', 'US'), (2, 'Ben', 'UK'), (3, 'Cy', 'US')")
            }
        }
    }

    @After
    fun cleanup() {
        dbFile.delete()
    }

    private fun descriptor() = ConnectionDescriptor(
        id = "duckdb-test", name = "duckdb-test", engine = EngineKind.DUCKDB, scope = ConnectionScope.PROJECT,
        filePath = dbFile.path,
    )

    @Test
    fun `real driver download, introspection, and query execution`() = runTest {
        val connection = JdbcConnectionFactory.open(descriptor(), password = null)
        val catalog = Introspectors.forEngine(EngineKind.DUCKDB).introspect(connection)
        val table = catalog.tables.first { it.name == "customers" }
        assertEquals(setOf("id", "name", "country"), table.columns.map { it.name }.toSet())

        val result = JdbcExecutor.execute(connection, "SELECT COUNT(*) AS n FROM customers WHERE country = 'US'", maxRows = 10, timeoutMs = 5000, EngineKind.DUCKDB)
        assertTrue("expected at least one row back", result.rows.isNotEmpty())
        connection.close()
    }

    @Test(expected = java.sql.SQLException::class)
    fun `the read-only property rejects a write even with the AST guard bypassed`() = runTest {
        val connection = JdbcConnectionFactory.open(descriptor(), password = null)
        connection.createStatement().use { st ->
            st.execute("INSERT INTO customers VALUES (4, 'Malicious', 'XX')")
        }
    }

    @Test(expected = java.sql.SQLException::class)
    fun `the read-only property rejects DDL as well as DML`() = runTest {
        val connection = JdbcConnectionFactory.open(descriptor(), password = null)
        connection.createStatement().use { st ->
            st.execute("DROP TABLE customers")
        }
    }

    // SqlGuard blocks all of these before the driver in production; this proves the defense-in-depth
    // layer underneath: a bypassed guard still can't attach a writable database or write a file.

    @Test(expected = java.sql.SQLException::class)
    fun `read-only connection cannot ATTACH a writable database`() = runTest {
        val connection = JdbcConnectionFactory.open(descriptor(), password = null)
        val otherFile = File.createTempFile("asksql-duckdb-attach-target", ".duckdb")
        otherFile.delete()
        try {
            connection.createStatement().use { st ->
                st.execute("ATTACH '${otherFile.path}' AS other")
                st.execute("CREATE TABLE other.evil (x INTEGER)")
            }
        } finally {
            otherFile.delete()
        }
    }

    // Unlike ATTACH, DuckDB's read-only connection property does NOT cover
    // `COPY ... TO`; it still writes the file. In production this statement
    // never reaches the driver at all (SqlGuard rejects COPY as unparseable,
    // see SqlGuardTest), so the guard (not the connection property) is the    // only thing standing between a user and an arbitrary file write here.
    @Test
    fun `read-only connection does NOT prevent COPY from writing a file - the guard is the only defense here`() = runTest {
        val connection = JdbcConnectionFactory.open(descriptor(), password = null)
        val outFile = File.createTempFile("asksql-duckdb-copy-target", ".csv")
        outFile.delete()
        try {
            connection.createStatement().use { st ->
                st.execute("COPY (SELECT * FROM customers) TO '${outFile.path}'")
            }
            assertTrue("expected COPY TO to have actually written the file, proving read_only does not cover it", outFile.exists())
        } finally {
            outFile.delete()
        }
    }

    /** Same concern as [PostgresJdbcIntegrationTest]'s concurrency test, for the embedded (not network-protocol) DuckDB driver. */
    @Test
    fun `many concurrent queries against the same shared connection each get their own correct result`() = runTest {
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val results = (1..20).map { n ->
            async {
                registry.withConnection(descriptor(), null) { connection ->
                    JdbcExecutor.execute(connection, "SELECT $n AS n", maxRows = 1, timeoutMs = 5000, EngineKind.DUCKDB)
                        .rows.first().first().let { com.rahulmahadik.asksql.ide.test.numericOrNull(it) ?: error("expected a number, got $it") }
                }
            }
        }.awaitAll()

        assertEquals((1..20).map { it.toDouble() }, results)
    }
}
