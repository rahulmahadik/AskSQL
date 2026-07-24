package com.rahulmahadik.asksql.ide.db.introspect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.sql.DriverManager

/** SQLite's generic JDBC metadata reports a blank FK_NAME and doesn't keep a multi-column FK's rows contiguous with more than one FK; see [SqliteIntrospector.loadForeignKeys]. */
class SqliteIntrospectorTest {

    private fun connect() = DriverManager.getConnection("jdbc:sqlite::memory:").also {
        Class.forName("org.sqlite.JDBC")
    }

    @Test fun `two single-column FKs to the same table are kept separate, not merged into one composite FK`() {
        connect().use { connection ->
            connection.createStatement().use { st ->
                st.execute("CREATE TABLE addresses (id INTEGER PRIMARY KEY, city TEXT)")
                st.execute(
                    """
                    CREATE TABLE orders (
                        id INTEGER PRIMARY KEY,
                        shipping_address_id INTEGER REFERENCES addresses(id),
                        billing_address_id INTEGER REFERENCES addresses(id)
                    )
                    """.trimIndent(),
                )
            }
            val catalog = SqliteIntrospector.introspect(connection)
            val orders = catalog.tables.first { it.name == "orders" }
            assertEquals("expected two separate single-column FKs, not one merged composite FK", 2, orders.foreignKeys.size)
            assertTrue(orders.foreignKeys.all { it.columns.size == 1 })
            assertEquals(setOf(listOf("shipping_address_id"), listOf("billing_address_id")), orders.foreignKeys.map { it.columns }.toSet())
        }
    }

    @Test fun `a real composite FK is kept together even when other FKs to the same table are interleaved`() {
        connect().use { connection ->
            connection.createStatement().use { st ->
                st.execute("CREATE TABLE addresses (country TEXT, region TEXT, city TEXT, PRIMARY KEY (country, region))")
                st.execute(
                    """
                    CREATE TABLE orders (
                        id INTEGER PRIMARY KEY,
                        shipping_address_id INTEGER REFERENCES addresses(country),
                        billing_address_id INTEGER REFERENCES addresses(country),
                        ship_country TEXT,
                        ship_region TEXT,
                        FOREIGN KEY (ship_country, ship_region) REFERENCES addresses(country, region)
                    )
                    """.trimIndent(),
                )
            }
            val catalog = SqliteIntrospector.introspect(connection)
            val orders = catalog.tables.first { it.name == "orders" }
            assertEquals(3, orders.foreignKeys.size)
            val composite = orders.foreignKeys.first { it.columns.size == 2 }
            assertEquals(listOf("ship_country", "ship_region"), composite.columns)
            assertEquals(listOf("country", "region"), composite.refColumns)
        }
    }

    @Test fun `a table with special characters in its name is still introspected correctly`() {
        connect().use { connection ->
            connection.createStatement().use { st ->
                st.execute("""CREATE TABLE "weird""table" (id INTEGER PRIMARY KEY)""")
                st.execute("""CREATE TABLE "child" (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "weird""table"(id))""")
            }
            val catalog = SqliteIntrospector.introspect(connection)
            val child = catalog.tables.first { it.name == "child" }
            assertEquals(1, child.foreignKeys.size)
            assertEquals("weird\"table", child.foreignKeys.first().refTable)
        }
    }
}
