package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.db.introspect.Introspectors
import com.rahulmahadik.asksql.ide.engine.CatalogPruner
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.RoutineVolatility
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import org.testcontainers.containers.PostgreSQLContainer
import java.util.Properties

/**
 * Proves, against a real Postgres, that introspection produces a correct catalog and that the
 * read-only session rejects a write at the database level even with the AST guard bypassed.
 */
@Category(IntegrationTest::class)
class PostgresJdbcIntegrationTest {

    private lateinit var container: PostgreSQLContainer<*>

    @Before
    fun startContainer() {
        container = PostgreSQLContainer("postgres:16-alpine")
        container.start()
        val driver = org.postgresql.Driver()
        val props = Properties().apply {
            setProperty("user", container.username)
            setProperty("password", container.password)
        }
        driver.connect(container.jdbcUrl, props)!!.use { setup ->
            setup.createStatement().use { st ->
                st.execute("CREATE TABLE customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, balance_cents BIGINT NOT NULL)")
                st.execute("INSERT INTO customers (name, balance_cents) VALUES ('Ava', 123456789012)")

                st.execute("CREATE TYPE mood AS ENUM ('happy', 'sad', 'neutral')")
                st.execute("CREATE TABLE moods (id SERIAL PRIMARY KEY, feeling mood NOT NULL)")

                st.execute("CREATE FUNCTION full_name(first text, last text) RETURNS text AS $$ SELECT first || ' ' || last $$ LANGUAGE sql IMMUTABLE")
                st.execute("CREATE FUNCTION audit_log(msg text) RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql VOLATILE")

                st.execute("CREATE TABLE events (id INT NOT NULL, created_at DATE NOT NULL, payload TEXT) PARTITION BY RANGE (created_at)")
                st.execute("CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')")

                // getColumns' table-name argument is a LIKE pattern; an
                // unescaped `_` can match an unrelated sibling table name.
                st.execute("CREATE TABLE foo_bar (only_in_foo_bar TEXT)")
                st.execute("CREATE TABLE fooxbar (only_in_fooxbar TEXT)")

                st.execute("CREATE TABLE bit_probe (flag1 bit(1), flags bit(8))")
                st.execute("INSERT INTO bit_probe VALUES ('1', '10100101')")

                // Classic table INHERITS also populates pg_inherits; must
                // not be mistaken for declarative partitioning.
                st.execute("CREATE TABLE parent_tab (id int primary key, name text)")
                st.execute("CREATE TABLE child_tab (extra int) INHERITS (parent_tab)")
            }
        }
    }

    @After
    fun stopContainer() {
        container.stop()
    }

    private fun openConnection(): java.sql.Connection {
        val driver = org.postgresql.Driver()
        val props = Properties().apply {
            setProperty("user", container.username)
            setProperty("password", container.password)
        }
        val connection = driver.connect(container.jdbcUrl, props)!!
        ReadOnlySession.enforce(connection, EngineKind.POSTGRES)
        return connection
    }

    @Test
    fun `introspection finds the seeded table and columns`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.POSTGRES).introspect(connection)
            val table = catalog.tables.first { it.name == "customers" }
            assertEquals(setOf("id", "name", "balance_cents"), table.columns.map { it.name }.toSet())
            assertEquals(listOf("id"), table.primaryKey)
        }
    }

    @Test
    fun `BIGINT round-trips as an exact string, never a lossy double`() = runTest {
        openConnection().use { connection ->
            val result = JdbcExecutor.execute(connection, "SELECT balance_cents FROM customers", maxRows = 10, timeoutMs = 5000, EngineKind.POSTGRES)
            val cell = result.rows.first().first()
            assertTrue("expected ExactNumeric for BIGINT", cell is CellValue.ExactNumeric)
            assertEquals("123456789012", (cell as CellValue.ExactNumeric).value)
        }
    }

    @Test(expected = java.sql.SQLException::class)
    fun `the read-only session rejects a write even with the AST guard bypassed`() {
        openConnection().use { connection ->
            connection.createStatement().use { st ->
                st.execute("INSERT INTO customers (name, balance_cents) VALUES ('Malicious', 0)")
            }
        }
    }

    @Test(expected = java.sql.SQLException::class)
    fun `the read-only session rejects DDL as well as DML`() {
        openConnection().use { connection ->
            connection.createStatement().use { st ->
                st.execute("DROP TABLE customers")
            }
        }
    }

    @Test
    fun `introspection captures enum column values`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.POSTGRES).introspect(connection)
            val column = catalog.tables.first { it.name == "moods" }.columns.first { it.name == "feeling" }
            assertEquals(listOf("happy", "sad", "neutral"), column.enumValues)
        }
    }

    @Test
    fun `introspection classifies function volatility for the callable-functions prompt feature`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.POSTGRES).introspect(connection)
            assertEquals(RoutineVolatility.IMMUTABLE, catalog.routines.first { it.name == "full_name" }.volatility)
            assertEquals(RoutineVolatility.VOLATILE, catalog.routines.first { it.name == "audit_log" }.volatility)

            // Only the immutable/stable function is ever offered to the model as callable.
            val schemaText = CatalogPruner.formatCatalogForPrompt(catalog)
            assertTrue(schemaText.contains("full_name("))
            assertFalse(schemaText.contains("audit_log("))
        }
    }

    @Test
    fun `introspection collapses partition children under their parent`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.POSTGRES).introspect(connection)
            assertTrue(catalog.tables.first { it.name == "events" }.isPartitioned)
            assertEquals("events", catalog.tables.first { it.name == "events_2024" }.partitionOf)

            val lines = CatalogPruner.formatCatalogForPrompt(catalog).lines()
            assertTrue("expected the partitioned parent to be rendered", lines.any { it.startsWith("TABLE events") && !it.contains("events_2024") })
            assertTrue("expected the partition child to be collapsed into its parent", lines.none { it.contains("events_2024") })
        }
    }

    /** `pg_inherits` also covers classic table INHERITS, not just declarative partition children - an INHERITS child must stay independently visible, not get collapsed as if it were a partition. */
    @Test
    fun `a classic INHERITS child is not mistaken for a partition child`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.POSTGRES).introspect(connection)
            val childTab = catalog.tables.first { it.name == "child_tab" }
            assertNull("an INHERITS child is not a real partition - must not be reported as one", childTab.partitionOf)

            val lines = CatalogPruner.formatCatalogForPrompt(catalog).lines()
            assertTrue("expected the INHERITS child to be rendered independently, not collapsed away", lines.any { it.startsWith("TABLE child_tab") })
        }
    }

    /**
     * [ConnectionRegistry.withConnection] allows concurrent leases on one [java.sql.Connection];
     * this proves that sharing doesn't corrupt concurrent query results over a real network protocol.
     */
    @Test
    fun `many concurrent queries against the same shared connection each get their own correct result`() = runTest {
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val descriptor = ConnectionDescriptor(
            id = "pg-concurrency", name = "pg-concurrency", engine = EngineKind.POSTGRES, scope = ConnectionScope.PROJECT,
            host = container.host, port = container.getMappedPort(5432), database = container.databaseName, user = container.username,
        )

        val results = (1..20).map { n ->
            async {
                registry.withConnection(descriptor, container.password) { connection ->
                    JdbcExecutor.execute(connection, "SELECT $n AS n", maxRows = 1, timeoutMs = 5000, EngineKind.POSTGRES)
                        .rows.first().first().let { it as CellValue.Number }.value
                }
            }
        }.awaitAll()

        assertEquals((1..20).map { it.toDouble() }, results)
    }

    /** getColumns' table-name argument is a LIKE pattern, not an exact match - an unescaped `_` (a normal character in a real table name) can match an unrelated sibling table and leak its columns in. */
    @Test
    fun `introspection does not leak a sibling table's columns via an unescaped underscore in the table name`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.POSTGRES).introspect(connection)
            val fooBar = catalog.tables.first { it.name == "foo_bar" }
            assertEquals(setOf("only_in_foo_bar"), fooBar.columns.map { it.name }.toSet())
        }
    }

    /** A single-bit column reads as a real boolean; a multi-bit bit(n) reads as text - getBoolean() throws on Postgres for n>1, so it must never be attempted there. */
    @Test
    fun `bit(1) reads as boolean, bit(8) reads as text rather than throwing`() = runTest {
        openConnection().use { connection ->
            val result = JdbcExecutor.execute(connection, "SELECT flag1, flags FROM bit_probe", maxRows = 10, timeoutMs = 5000, EngineKind.POSTGRES)
            val row = result.rows.first()
            assertTrue("bit(1) should read as Boolean", row[0] is CellValue.Boolean)
            assertEquals(true, (row[0] as CellValue.Boolean).value)
            assertTrue("bit(8) should read as Text, not throw or collapse to a boolean", row[1] is CellValue.Text)
            assertEquals("10100101", (row[1] as CellValue.Text).value)
        }
    }
}
