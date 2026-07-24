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

/** MySQL/MariaDB counterpart to [PostgresBatchedIntrospectionLiveTest]: proves the batched `getColumns()` call is correct against mariadb-java-client, using its own throwaway database. */
@Category(IntegrationTest::class)
class MySqlBatchedIntrospectionLiveTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 53306
        private const val USER = "root"
        private const val DB = "asksql_batch_introspect_test"
    }

    private var mysqlAvailable = false

    private fun openAdminConnection(database: String? = DB): Connection =
        DriverProvisioner.driverFor(EngineKind.MYSQL).connect(
            "jdbc:mariadb://$HOST:$PORT/${database ?: ""}?permitMysqlScheme=true",
            Properties().apply { setProperty("user", USER) },
        )!!

    @Before
    fun setUp() {
        mysqlAvailable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
        if (!mysqlAvailable) return
        openAdminConnection(database = null).use { connection ->
            connection.createStatement().use { st ->
                st.execute("DROP DATABASE IF EXISTS $DB")
                st.execute("CREATE DATABASE $DB")
                st.execute("USE $DB")
                // Same underscore-collision shape as MySqlJdbcIntegrationTest's Testcontainers
                // version; see PostgresBatchedIntrospectionLiveTest's identical comment for why the
                // batched call sidesteps it entirely (never uses a specific table name as the LIKE
                // pattern, so there's nothing for an unescaped `_`/`%` to collide with).
                st.execute("CREATE TABLE foo_bar (id INT PRIMARY KEY, only_in_foo_bar TEXT)")
                st.execute("CREATE TABLE fooxbar (id INT PRIMARY KEY, only_in_fooxbar TEXT)")
                st.execute("CREATE TABLE orders (id INT PRIMARY KEY, foo_bar_id INT, FOREIGN KEY (foo_bar_id) REFERENCES foo_bar(id))")
            }
        }
    }

    @After
    fun tearDown() {
        if (!mysqlAvailable) return
        openAdminConnection(database = null).use { connection ->
            connection.createStatement().use { st -> st.execute("DROP DATABASE IF EXISTS $DB") }
        }
    }

    @Test
    fun `batched getColumns does not mix up a sibling table's columns via an unescaped underscore`() {
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping the live introspection test", mysqlAvailable)
        openAdminConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.MYSQL).introspect(connection)
            val fooBar = catalog.tables.first { it.name == "foo_bar" }
            val fooxbar = catalog.tables.first { it.name == "fooxbar" }
            assertEquals(setOf("id", "only_in_foo_bar"), fooBar.columns.map { it.name }.toSet())
            assertEquals(setOf("id", "only_in_fooxbar"), fooxbar.columns.map { it.name }.toSet())
        }
    }

    @Test
    fun `batched introspection still resolves primary keys and foreign keys correctly across multiple tables`() {
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping the live introspection test", mysqlAvailable)
        openAdminConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.MYSQL).introspect(connection)
            val orders = catalog.tables.first { it.name == "orders" }
            assertEquals(listOf("id"), orders.primaryKey)
            assertEquals(1, orders.foreignKeys.size)
            assertEquals("foo_bar", orders.foreignKeys.first().refTable)
            assertEquals(listOf("foo_bar_id"), orders.foreignKeys.first().columns)
        }
    }
}
