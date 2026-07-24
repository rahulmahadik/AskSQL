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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import org.testcontainers.containers.MySQLContainer
import java.util.Properties

/**
 * Proves, against a real MySQL, that [com.rahulmahadik.asksql.ide.db.introspect.MySqlIntrospector]
 * populates `ENUM(...)` column literal values and routine volatility, both of which
 * [com.rahulmahadik.asksql.ide.engine.CatalogPruner] renders into the prompt when present.
 */
@Category(IntegrationTest::class)
class MySqlJdbcIntegrationTest {

    private lateinit var container: MySQLContainer<*>

    @Before
    fun startContainer() {
        // --log-bin-trust-function-creators lets the fixtures below create stored functions without
        // SUPER (binlog is on by default). Set at server start; MySQL 8 restricts root to localhost.
        container = MySQLContainer("mysql:8.4").withCommand("mysqld", "--log-bin-trust-function-creators=ON")
        container.start()
        rawConnection().use { setup ->
            setup.createStatement().use { st ->
                st.execute("CREATE TABLE moods (id INT AUTO_INCREMENT PRIMARY KEY, feeling ENUM('happy','sad','neutral') NOT NULL)")
                st.execute(
                    "CREATE FUNCTION full_name(first_name VARCHAR(50), last_name VARCHAR(50)) " +
                        "RETURNS VARCHAR(101) DETERMINISTIC RETURN CONCAT(first_name, ' ', last_name)",
                )
                st.execute(
                    "CREATE FUNCTION current_greeting() RETURNS VARCHAR(50) NOT DETERMINISTIC NO SQL " +
                        "RETURN CONCAT('Hello at ', NOW())",
                )
                // getColumns' table-name argument is a LIKE pattern; an
                // unescaped `_` can match an unrelated sibling table name.
                st.execute("CREATE TABLE foo_bar (only_in_foo_bar TEXT)")
                st.execute("CREATE TABLE fooxbar (only_in_fooxbar TEXT)")

                st.execute("CREATE TABLE bit_probe (flag1 BIT(1), flags BIT(8))")
                st.execute("INSERT INTO bit_probe VALUES (1, b'10100101')")

                st.execute("SET sql_mode=''") // strict mode (MySQL 5.7+ default) rejects zero-dates outright
                st.execute("CREATE TABLE zerodate_probe (d DATE, dt DATETIME)")
                st.execute("INSERT INTO zerodate_probe VALUES ('0000-00-00', '0000-00-00 00:00:00')")
                st.execute("INSERT INTO zerodate_probe VALUES (NULL, NULL)")
            }
        }
    }

    @After
    fun stopContainer() {
        container.stop()
    }

    private fun rawConnection(): java.sql.Connection {
        val props = Properties().apply {
            setProperty("user", container.username)
            setProperty("password", container.password)
        }
        // Production ships the MariaDB driver, which only accepts the jdbc:mariadb scheme;
        // testcontainers hands back a jdbc:mysql URL, so rewrite it (as production connects).
        val url = container.jdbcUrl.replaceFirst("jdbc:mysql://", "jdbc:mariadb://")
        return org.mariadb.jdbc.Driver().connect(url, props)!!
    }

    private fun openConnection(): java.sql.Connection {
        val connection = rawConnection()
        ReadOnlySession.enforce(connection, EngineKind.MYSQL)
        return connection
    }

    @Test
    fun `introspection captures ENUM column values`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.MYSQL).introspect(connection)
            val column = catalog.tables.first { it.name == "moods" }.columns.first { it.name == "feeling" }
            assertEquals(listOf("happy", "sad", "neutral"), column.enumValues)
        }
    }

    @Test
    fun `introspection classifies routine volatility for the callable-functions prompt feature`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.MYSQL).introspect(connection)
            assertEquals(RoutineVolatility.STABLE, catalog.routines.first { it.name == "full_name" }.volatility)
            assertEquals(RoutineVolatility.UNKNOWN, catalog.routines.first { it.name == "current_greeting" }.volatility)

            val schemaText = CatalogPruner.formatCatalogForPrompt(catalog)
            assertTrue(schemaText.contains("full_name("))
            assertFalse(schemaText.contains("current_greeting("))
        }
    }

    /** getColumns' table-name argument is a LIKE pattern, not an exact match - an unescaped `_` (a normal character in a real table name) can match an unrelated sibling table and leak its columns in. */
    @Test
    fun `introspection does not leak a sibling table's columns via an unescaped underscore in the table name`() {
        openConnection().use { connection ->
            val catalog = Introspectors.forEngine(EngineKind.MYSQL).introspect(connection)
            val fooBar = catalog.tables.first { it.name == "foo_bar" }
            assertEquals(setOf("only_in_foo_bar"), fooBar.columns.map { it.name }.toSet())
        }
    }

    /** A single-bit column reads as a real boolean; a multi-bit BIT(n) reads as text rather than silently collapsing to true/false and losing the value. */
    @Test
    fun `BIT(1) reads as boolean, BIT(8) reads as text rather than collapsing to a boolean`() = runTest {
        openConnection().use { connection ->
            val result = JdbcExecutor.execute(connection, "SELECT flag1, flags FROM bit_probe", maxRows = 10, timeoutMs = 5000, EngineKind.MYSQL)
            val row = result.rows.first()
            assertTrue("BIT(1) should read as Boolean", row[0] is CellValue.Boolean)
            assertTrue("BIT(8) should read as Text, not collapse to a boolean", row[1] is CellValue.Text)
        }
    }

    /**
     * MariaDB's driver returns the correct zero-value DATETIME string from getString(), but
     * wasNull() falsely reports true right after; a genuine SQL NULL must still read as Null.
     */
    @Test
    fun `a zero-value DATETIME reads as text, not a misleading NULL, while a genuine NULL still reads as Null`() = runTest {
        openConnection().use { connection ->
            val zero = JdbcExecutor.execute(connection, "SELECT d, dt FROM zerodate_probe WHERE d IS NOT NULL", maxRows = 10, timeoutMs = 5000, EngineKind.MYSQL)
            val zeroRow = zero.rows.first()
            assertEquals(CellValue.Text("0000-00-00"), zeroRow[0])
            assertEquals(CellValue.Text("0000-00-00 00:00:00"), zeroRow[1])

            val nulls = JdbcExecutor.execute(connection, "SELECT d, dt FROM zerodate_probe WHERE d IS NULL", maxRows = 10, timeoutMs = 5000, EngineKind.MYSQL)
            val nullRow = nulls.rows.first()
            assertEquals(CellValue.Null, nullRow[0])
            assertEquals(CellValue.Null, nullRow[1])
        }
    }

    /** Same concern as [PostgresJdbcIntegrationTest]'s concurrency test, for the MariaDB Connector/J driver. */
    @Test
    fun `many concurrent queries against the same shared connection each get their own correct result`() = runTest {
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val descriptor = ConnectionDescriptor(
            id = "mysql-concurrency", name = "mysql-concurrency", engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
            host = container.host, port = container.getMappedPort(3306), database = container.databaseName, user = container.username,
        )

        val results = (1..20).map { n ->
            async {
                registry.withConnection(descriptor, container.password) { connection ->
                    JdbcExecutor.execute(connection, "SELECT $n AS n", maxRows = 1, timeoutMs = 5000, EngineKind.MYSQL)
                        .rows.first().first().let { (it as CellValue.ExactNumeric).value.toDouble() }
                }
            }
        }.awaitAll()

        assertEquals((1..20).map { it.toDouble() }, results)
    }
}
