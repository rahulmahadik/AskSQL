package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.db.DriverProvisioner
import com.rahulmahadik.asksql.ide.db.DuckDbFileLoader
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.TableSource
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.experimental.categories.Category
import java.io.File
import java.sql.Connection
import java.util.Properties

/** Proves [DuckDbFileLoader] end to end: a .sql dump creates tables, a CSV loads as a queryable view, unsafe dumps are rejected, and [DuckDbIntrospector] tags every loaded table/view [TableSource.FILE]. */
@Category(IntegrationTest::class)
class DuckDbFileLoadTest {

    private fun freshConnection(): Connection {
        val dbFile = File.createTempFile("asksql-duckdb-upload-test", ".duckdb")
        dbFile.delete()
        val driver = kotlinx.coroutines.runBlocking { DriverProvisioner.duckDbDriver() }
        return driver.connect("jdbc:duckdb:${dbFile.path}", Properties())!!
    }

    private fun tempFile(suffix: String, content: String): File {
        val file = File.createTempFile("asksql-upload-source", suffix)
        file.writeText(content)
        file.deleteOnExit()
        return file
    }

    @Test
    fun `a plain sql dump creates its tables and they are tagged TableSource FILE`() = runTest {
        freshConnection().use { connection ->
            val dumpFile = tempFile(".sql", "CREATE TABLE widgets (id INTEGER, name TEXT); INSERT INTO widgets VALUES (1, 'Ava'), (2, 'Ben');")

            val created = DuckDbFileLoader.loadFile(connection, dumpFile.path)
            assertEquals(listOf("widgets"), created)

            val catalog = DuckDbIntrospector.introspect(connection)
            val widgets = catalog.tables.first { it.name == "widgets" }
            assertEquals(TableSource.FILE, widgets.source)

            connection.createStatement().use { st ->
                st.executeQuery("SELECT COUNT(*) AS n FROM widgets").use { rs ->
                    rs.next()
                    assertEquals(2, rs.getInt("n"))
                }
            }
        }
    }

    @Test
    fun `a multi-table sql dump creates and tags every table`() = runTest {
        freshConnection().use { connection ->
            val dumpFile = tempFile(".sql", "CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER); INSERT INTO a VALUES (1); INSERT INTO b VALUES (1);")

            val created = DuckDbFileLoader.loadFile(connection, dumpFile.path)
            assertEquals(setOf("a", "b"), created.toSet())

            val catalog = DuckDbIntrospector.introspect(connection)
            assertTrue(catalog.tables.filter { it.name in setOf("a", "b") }.all { it.source == TableSource.FILE })
        }
    }

    @Test
    fun `a table that already existed before the dump is not retroactively tagged FILE`() = runTest {
        freshConnection().use { connection ->
            connection.createStatement().use { st -> st.execute("CREATE TABLE preexisting (id INTEGER)") }
            val dumpFile = tempFile(".sql", "CREATE TABLE uploaded (id INTEGER); INSERT INTO uploaded VALUES (1);")

            DuckDbFileLoader.loadFile(connection, dumpFile.path)

            val catalog = DuckDbIntrospector.introspect(connection)
            assertEquals(TableSource.DB, catalog.tables.first { it.name == "preexisting" }.source)
            assertEquals(TableSource.FILE, catalog.tables.first { it.name == "uploaded" }.source)
        }
    }

    @Test
    fun `a csv file loads as a queryable view tagged TableSource FILE`() = runTest {
        freshConnection().use { connection ->
            val csvFile = tempFile(".csv", "id,name\n1,Ava\n2,Ben\n")

            val created = DuckDbFileLoader.loadFile(connection, csvFile.path, tableNameHint = "customers")
            assertEquals(listOf("customers"), created)

            val catalog = DuckDbIntrospector.introspect(connection)
            assertEquals(TableSource.FILE, catalog.tables.first { it.name == "customers" }.source)

            connection.createStatement().use { st ->
                st.executeQuery("SELECT COUNT(*) AS n FROM customers").use { rs ->
                    rs.next()
                    assertEquals(2, rs.getInt("n"))
                }
            }
        }
    }

    @Test
    fun `multiple files load into the same connection as separate queryable tables`() = runTest {
        freshConnection().use { connection ->
            val customersCsv = tempFile(".csv", "id,name\n1,Ava\n2,Ben\n")
            val productsCsv = tempFile(".csv", "id,name,price\n1,Widget,9.99\n")

            val expectedNames = listOf(customersCsv, productsCsv).map { DuckDbFileLoader.sanitizeTableName(it.name) }
            val created = listOf(customersCsv, productsCsv).flatMap { file ->
                DuckDbFileLoader.loadFile(connection, file.path, tableNameHint = file.nameWithoutExtension)
            }
            assertEquals(expectedNames, created)

            connection.createStatement().use { st ->
                st.executeQuery("SELECT COUNT(*) AS n FROM ${expectedNames[0]}").use { rs -> rs.next(); assertEquals(2, rs.getInt("n")) }
                st.executeQuery("SELECT COUNT(*) AS n FROM ${expectedNames[1]}").use { rs -> rs.next(); assertEquals(1, rs.getInt("n")) }
            }
        }
    }

    @Test
    fun `a query joins across two separately-loaded files in the same connection`() = runTest {
        freshConnection().use { connection ->
            val customersCsv = tempFile(".csv", "id,name\n1,Ava\n2,Ben\n")
            val ordersCsv = tempFile(".csv", "id,customer_id,total\n100,1,50.00\n101,1,25.00\n102,2,10.00\n")

            DuckDbFileLoader.loadFile(connection, customersCsv.path, tableNameHint = "customers")
            DuckDbFileLoader.loadFile(connection, ordersCsv.path, tableNameHint = "orders")

            val catalog = DuckDbIntrospector.introspect(connection)
            assertTrue(catalog.tables.any { it.name == "customers" } && catalog.tables.any { it.name == "orders" })

            connection.createStatement().use { st ->
                st.executeQuery(
                    "SELECT c.name, COUNT(*) AS n FROM customers c JOIN orders o ON o.customer_id = c.id " +
                        "GROUP BY c.name ORDER BY c.name",
                ).use { rs ->
                    rs.next()
                    assertEquals("Ava", rs.getString("name"))
                    assertEquals(2, rs.getInt("n"))
                    rs.next()
                    assertEquals("Ben", rs.getString("name"))
                    assertEquals(1, rs.getInt("n"))
                }
            }
        }
    }

    @Test
    fun `csv, json, ndjson, parquet and a sql dump all load together into one connection`() = runTest {
        freshConnection().use { connection ->
            val customersCsv = tempFile(".csv", "id,name\n1,Ava\n2,Ben\n")
            val ordersJson = tempFile(".json", """[{"id":100,"customer_id":1,"total":50.0},{"id":101,"customer_id":2,"total":10.0}]""")
            val eventsNdjson = tempFile(".ndjson", "{\"id\":1,\"kind\":\"login\"}\n{\"id\":2,\"kind\":\"logout\"}\n")
            val productsSql = tempFile(".sql", "CREATE TABLE products (id INTEGER, name TEXT); INSERT INTO products VALUES (1, 'Widget'), (2, 'Gadget');")

            val parquetFile = File.createTempFile("asksql-upload-source", ".parquet")
            parquetFile.delete()
            connection.createStatement().use { st ->
                st.execute("CREATE TEMP TABLE tmp_reviews (id INTEGER, stars INTEGER)")
                st.execute("INSERT INTO tmp_reviews VALUES (1, 5), (2, 3)")
                st.execute("COPY tmp_reviews TO '${parquetFile.path}' (FORMAT PARQUET)")
                st.execute("DROP TABLE tmp_reviews")
            }

            val createdCustomers = DuckDbFileLoader.loadFile(connection, customersCsv.path, tableNameHint = "customers")
            val createdOrders = DuckDbFileLoader.loadFile(connection, ordersJson.path, tableNameHint = "orders")
            val createdEvents = DuckDbFileLoader.loadFile(connection, eventsNdjson.path, tableNameHint = "events")
            val createdReviews = DuckDbFileLoader.loadFile(connection, parquetFile.path, tableNameHint = "reviews")
            val createdProducts = DuckDbFileLoader.loadFile(connection, productsSql.path)

            assertEquals(listOf("customers"), createdCustomers)
            assertEquals(listOf("orders"), createdOrders)
            assertEquals(listOf("events"), createdEvents)
            assertEquals(listOf("reviews"), createdReviews)
            assertEquals(listOf("products"), createdProducts)

            val catalog = DuckDbIntrospector.introspect(connection)
            for (name in listOf("customers", "orders", "events", "reviews", "products")) {
                assertEquals(TableSource.FILE, catalog.tables.first { it.name == name }.source)
            }

            connection.createStatement().use { st ->
                st.executeQuery("SELECT COUNT(*) AS n FROM customers").use { rs -> rs.next(); assertEquals(2, rs.getInt("n")) }
                st.executeQuery("SELECT COUNT(*) AS n FROM orders").use { rs -> rs.next(); assertEquals(2, rs.getInt("n")) }
                st.executeQuery("SELECT COUNT(*) AS n FROM events").use { rs -> rs.next(); assertEquals(2, rs.getInt("n")) }
                st.executeQuery("SELECT COUNT(*) AS n FROM reviews").use { rs -> rs.next(); assertEquals(2, rs.getInt("n")) }
                st.executeQuery("SELECT COUNT(*) AS n FROM products").use { rs -> rs.next(); assertEquals(2, rs.getInt("n")) }
            }

            parquetFile.delete()
        }
    }

    @Test
    fun `a query joins across three differently-typed loaded files in the same connection`() = runTest {
        freshConnection().use { connection ->
            val customersCsv = tempFile(".csv", "id,name\n1,Ava\n2,Ben\n")
            val ordersJson = tempFile(".json", """[{"id":100,"customer_id":1},{"id":101,"customer_id":1},{"id":102,"customer_id":2}]""")

            val itemsParquetFile = File.createTempFile("asksql-upload-source", ".parquet")
            itemsParquetFile.delete()
            connection.createStatement().use { st ->
                st.execute("CREATE TEMP TABLE tmp_items (order_id INTEGER, total_cents INTEGER)")
                st.execute("INSERT INTO tmp_items VALUES (100, 5000), (101, 2500), (102, 1000)")
                st.execute("COPY tmp_items TO '${itemsParquetFile.path}' (FORMAT PARQUET)")
                st.execute("DROP TABLE tmp_items")
            }

            DuckDbFileLoader.loadFile(connection, customersCsv.path, tableNameHint = "customers")
            DuckDbFileLoader.loadFile(connection, ordersJson.path, tableNameHint = "orders")
            DuckDbFileLoader.loadFile(connection, itemsParquetFile.path, tableNameHint = "order_items")

            connection.createStatement().use { st ->
                st.executeQuery(
                    "SELECT c.name, SUM(oi.total_cents) AS total FROM customers c " +
                        "JOIN orders o ON o.customer_id = c.id " +
                        "JOIN order_items oi ON oi.order_id = o.id " +
                        "GROUP BY c.name ORDER BY c.name",
                ).use { rs ->
                    rs.next()
                    assertEquals("Ava", rs.getString("name"))
                    assertEquals(7500, rs.getInt("total"))
                    rs.next()
                    assertEquals("Ben", rs.getString("name"))
                    assertEquals(1000, rs.getInt("total"))
                }
            }

            itemsParquetFile.delete()
        }
    }

    @Test
    fun `an xlsx file round-trips through DuckDB's own excel extension and loads as a queryable view`() = runTest {
        freshConnection().use { connection ->
            val xlsxFile = File.createTempFile("asksql-upload-source", ".xlsx")
            xlsxFile.delete()
            connection.createStatement().use { st ->
                st.execute("INSTALL excel")
                st.execute("LOAD excel")
                st.execute("CREATE TEMP TABLE tmp_staff (id INTEGER, name TEXT)")
                st.execute("INSERT INTO tmp_staff VALUES (1, 'Ava'), (2, 'Ben'), (3, 'Cy')")
                st.execute("COPY tmp_staff TO '${xlsxFile.path}' (FORMAT xlsx, HEADER true)")
                st.execute("DROP TABLE tmp_staff")
            }

            val created = DuckDbFileLoader.loadFile(connection, xlsxFile.path, tableNameHint = "staff")
            assertEquals(listOf("staff"), created)

            val catalog = DuckDbIntrospector.introspect(connection)
            assertEquals(TableSource.FILE, catalog.tables.first { it.name == "staff" }.source)

            connection.createStatement().use { st ->
                st.executeQuery("SELECT COUNT(*) AS n FROM staff").use { rs -> rs.next(); assertEquals(3, rs.getInt("n")) }
            }

            xlsxFile.delete()
        }
    }

    @Test
    fun `a dump that creates no tables is rejected`() = runTest {
        freshConnection().use { connection ->
            val dumpFile = tempFile(".sql", "SELECT 1;")
            var thrown: AskSqlException? = null
            try {
                DuckDbFileLoader.loadFile(connection, dumpFile.path)
                fail("expected a rejection for a dump that creates no tables")
            } catch (e: AskSqlException) {
                thrown = e
            }
            assertTrue(thrown!!.userMessage.contains("created no tables"))
        }
    }

    @Test
    fun `a vendor mysqldump is rejected before it ever reaches the database`() = runTest {
        freshConnection().use { connection ->
            val dumpFile = tempFile(".sql", "CREATE TABLE `t` (`id` int) ENGINE=InnoDB;")
            var thrown: AskSqlException? = null
            try {
                DuckDbFileLoader.loadFile(connection, dumpFile.path)
                fail("expected the mysqldump-style file to be rejected")
            } catch (e: AskSqlException) {
                thrown = e
            }
            assertTrue(thrown!!.userMessage.contains("MySQL"))

            // Prove it never ran: no tables exist beyond the loader's own marker table.
            val catalog = DuckDbIntrospector.introspect(connection)
            assertTrue(catalog.tables.isEmpty())
        }
    }

    @Test
    fun `a dump containing ATTACH is rejected before it ever reaches the database`() = runTest {
        freshConnection().use { connection ->
            val otherFile = File.createTempFile("asksql-attack-target", ".duckdb")
            otherFile.delete()
            val dumpFile = tempFile(".sql", "ATTACH '${otherFile.path}' AS evil; CREATE TABLE evil.x (id INTEGER);")
            try {
                var thrown: AskSqlException? = null
                try {
                    DuckDbFileLoader.loadFile(connection, dumpFile.path)
                    fail("expected the ATTACH statement to be rejected")
                } catch (e: AskSqlException) {
                    thrown = e
                }
                assertTrue(thrown!!.detail?.contains("ATTACH") == true)
                assertTrue("expected ATTACH to never have run", !otherFile.exists())
            } finally {
                otherFile.delete()
            }
        }
    }
}
