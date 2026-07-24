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
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import org.testcontainers.containers.OracleContainer
import java.sql.Connection
import java.util.Properties

/**
 * Proves, against a real Oracle instance, that introspection produces a correct catalog and that
 * the per-query read-only re-arm ([ReadOnlySession]/[JdbcExecutor]) actually rejects a write,
 * since Oracle's read-only guarantee is transaction-scoped, not session-scoped.
 */
@Category(IntegrationTest::class)
class OracleJdbcIntegrationTest {

    private lateinit var container: OracleContainer

    @Before
    fun startContainer() {
        // JUnit4 requires @Before methods to return void; runBlocking's
        // result type would otherwise be inferred from its last expression
        // (Statement.execute()'s Boolean), so this stays a block body.
        runBlocking {
            // Plain blocking wait, not runTest's virtual time: Oracle containers take 1-2 minutes to
            // become ready, and a coroutine-test watchdog would mistake that for a hang.
            // OracleContainer hardcodes PDB "xepdb1", which only exists in gvenzl/oracle-xe (not
            // oracle-free); "faststart" skips first-run initialization to cut startup time.
            container = OracleContainer("gvenzl/oracle-xe:21-slim-faststart")
            container.start()

            // Exercises the real lazy-downloaded driver path (see
            // DriverProvisioner), same as DuckDbIntegrationTest does for DuckDB.
            val driver = DriverProvisioner.oracleDriver()
            val props = Properties().apply {
                setProperty("user", container.username)
                setProperty("password", container.password)
            }
            driver.connect(container.jdbcUrl, props)!!.use { setup ->
                setup.createStatement().use { st ->
                    // Autocommit is on by default; DDL always auto-commits in
                    // Oracle regardless, and an explicit commit() while
                    // autoCommit=true throws; so none is called here.
                    st.execute(
                        """
                        CREATE TABLE customers (
                            id NUMBER GENERATED ALWAYS AS IDENTITY,
                            name VARCHAR2(100) NOT NULL,
                            balance NUMBER(20,0) NOT NULL,
                            CONSTRAINT pk_customers PRIMARY KEY (id)
                        )
                        """.trimIndent(),
                    )
                    st.execute("INSERT INTO customers (name, balance) VALUES ('Ava', 123456789012)")
                }
            }
        }
    }

    @After
    fun stopContainer() {
        container.stop()
    }

    private fun descriptor() = ConnectionDescriptor(
        id = "oracle-test", name = "oracle-test", engine = EngineKind.ORACLE, scope = ConnectionScope.PROJECT,
        host = container.host, port = container.oraclePort, database = container.databaseName,
        user = container.username,
    )

    private suspend fun openConnection(): Connection = JdbcConnectionFactory.open(descriptor(), container.password)

    @Test
    fun `real driver download, introspection, and query execution`() = runTest {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.ORACLE).introspect(connection)
            val table = catalog.tables.first { it.name.equals("customers", ignoreCase = true) }
            assertEquals(setOf("ID", "NAME", "BALANCE"), table.columns.map { it.name.uppercase() }.toSet())

            val result = JdbcExecutor.execute(connection, "SELECT balance FROM customers", maxRows = 10, timeoutMs = 5000, EngineKind.ORACLE)
            assertTrue("expected at least one row back", result.rows.isNotEmpty())
        }
    }

    @Test
    fun `large NUMBER round-trips as an exact string, never a lossy double`() = runTest {
        openConnection().use { connection ->
            val result = JdbcExecutor.execute(connection, "SELECT balance FROM customers", maxRows = 10, timeoutMs = 5000, EngineKind.ORACLE)
            val cell = result.rows.first().first()
            assertTrue("expected ExactNumeric for a large NUMBER", cell is CellValue.ExactNumeric)
            assertEquals("123456789012", (cell as CellValue.ExactNumeric).value)
        }
    }

    @Test(expected = java.sql.SQLException::class)
    fun `the per-query read-only re-arm rejects a write even with the AST guard bypassed`() = runTest {
        openConnection().use { connection ->
            // Arm exactly as JdbcExecutor does: autoCommit=false so SET TRANSACTION READ ONLY isn't
            // committed away before the write. Oracle then rejects the INSERT (ORA-01456).
            connection.autoCommit = false
            connection.createStatement().use { st ->
                st.execute("SET TRANSACTION READ ONLY")
                st.execute("INSERT INTO customers (name, balance) VALUES ('Malicious', 0)")
            }
        }
    }

    @Test
    fun `the per-query re-arm does not freeze reads to a stale snapshot`() = runTest {
        openConnection().use { readerConnection ->
            val before = JdbcExecutor.execute(readerConnection, "SELECT COUNT(*) AS n FROM customers", maxRows = 1, timeoutMs = 5000, EngineKind.ORACLE)
                .rows.first().first().let { (it as CellValue.ExactNumeric).value.toDouble() }

            // A second, ordinary (writable) connection inserts a new row: must be visible to the
            // NEXT query on readerConnection, proving the read-only transaction is re-armed each call
            // rather than pinned to one snapshot for the connection's whole life.
            val driver = DriverProvisioner.oracleDriver()
            val props = Properties().apply {
                setProperty("user", container.username)
                setProperty("password", container.password)
            }
            driver.connect(container.jdbcUrl, props)!!.use { writer ->
                writer.createStatement().use { it.execute("INSERT INTO customers (name, balance) VALUES ('Ben', 1)") }
            }

            val after = JdbcExecutor.execute(readerConnection, "SELECT COUNT(*) AS n FROM customers", maxRows = 1, timeoutMs = 5000, EngineKind.ORACLE)
                .rows.first().first().let { (it as CellValue.ExactNumeric).value.toDouble() }

            assertEquals(before + 1, after, 0.0)
        }
    }

    /** Same concern as [PostgresJdbcIntegrationTest]'s concurrency test, for Oracle's per-query read-only re-arm. */
    @Test
    fun `many concurrent queries against the same shared connection each get their own correct result`() = runTest {
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val results = (1..20).map { n ->
            async {
                registry.withConnection(descriptor(), container.password) { connection ->
                    JdbcExecutor.execute(connection, "SELECT $n AS n FROM dual", maxRows = 1, timeoutMs = 5000, EngineKind.ORACLE)
                        .rows.first().first().let { (it as CellValue.ExactNumeric).value }
                }
            }
        }.awaitAll()

        assertEquals((1..20).map { it.toString() }, results)
    }
}
