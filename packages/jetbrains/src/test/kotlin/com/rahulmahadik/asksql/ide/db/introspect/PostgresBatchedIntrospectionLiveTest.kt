package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.db.DriverProvisioner
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.net.Socket
import java.sql.Connection
import java.util.Properties

/**
 * Proves [CommonIntrospection.listTables]'s batched `getColumns()` call (one round-trip per schema,
 * not per table) is correct against a real, locally-running Postgres. Uses its own throwaway schema.
 */
@Category(IntegrationTest::class)
class PostgresBatchedIntrospectionLiveTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 55432
        private const val DB = "asksql_demo"
        private const val USER = "asksql"
        private const val SCHEMA = "asksql_batch_introspect_test"
    }

    private var postgresAvailable = false

    private fun openAdminConnection(): Connection =
        DriverProvisioner.driverFor(EngineKind.POSTGRES).connect(
            "jdbc:postgresql://$HOST:$PORT/$DB",
            Properties().apply { setProperty("user", USER) },
        )!!

    @Before
    fun setUp() {
        postgresAvailable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
        if (!postgresAvailable) return
        openAdminConnection().use { connection ->
            connection.createStatement().use { st ->
                st.execute("DROP SCHEMA IF EXISTS $SCHEMA CASCADE")
                st.execute("CREATE SCHEMA $SCHEMA")
                // Same underscore-collision shape as PostgresJdbcIntegrationTest's Testcontainers
                // version: getColumns' tableNamePattern is a LIKE pattern, so "foo_bar" as a QUERY
                // parameter can match "fooxbar" too; the batched call sidesteps this by never using
                // a specific table name as the pattern at all (always "%"), then grouping the result
                // by the EXACT (schema, table) returned per row.
                st.execute("CREATE TABLE $SCHEMA.foo_bar (id INT PRIMARY KEY, only_in_foo_bar TEXT)")
                st.execute("CREATE TABLE $SCHEMA.fooxbar (id INT PRIMARY KEY, only_in_fooxbar TEXT)")
                st.execute("CREATE TABLE $SCHEMA.orders (id INT PRIMARY KEY, foo_bar_id INT REFERENCES $SCHEMA.foo_bar(id))")
            }
        }
    }

    @After
    fun tearDown() {
        if (!postgresAvailable) return
        openAdminConnection().use { connection ->
            connection.createStatement().use { st -> st.execute("DROP SCHEMA IF EXISTS $SCHEMA CASCADE") }
        }
    }

    @Test
    fun `batched getColumns does not mix up a sibling table's columns via an unescaped underscore`() {
        assumeTrue("Postgres is not reachable on localhost:$PORT - skipping the live introspection test", postgresAvailable)
        openAdminConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.POSTGRES).introspect(connection)
            val fooBar = catalog.tables.first { it.schema == SCHEMA && it.name == "foo_bar" }
            val fooxbar = catalog.tables.first { it.schema == SCHEMA && it.name == "fooxbar" }
            assertEquals(setOf("id", "only_in_foo_bar"), fooBar.columns.map { it.name }.toSet())
            assertEquals(setOf("id", "only_in_fooxbar"), fooxbar.columns.map { it.name }.toSet())
        }
    }

    @Test
    fun `batched introspection still resolves primary keys and foreign keys correctly across multiple tables`() {
        assumeTrue("Postgres is not reachable on localhost:$PORT - skipping the live introspection test", postgresAvailable)
        openAdminConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.POSTGRES).introspect(connection)
            val orders = catalog.tables.first { it.schema == SCHEMA && it.name == "orders" }
            assertEquals(listOf("id"), orders.primaryKey)
            assertEquals(1, orders.foreignKeys.size)
            assertEquals("foo_bar", orders.foreignKeys.first().refTable)
            assertEquals(listOf("foo_bar_id"), orders.foreignKeys.first().columns)
        }
    }
}
