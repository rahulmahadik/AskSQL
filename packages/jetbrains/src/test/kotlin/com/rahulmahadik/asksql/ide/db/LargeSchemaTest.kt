package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.db.introspect.SqliteIntrospector
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.sql.Connection
import java.sql.DriverManager

/**
 * A database may have as many tables and columns as it likes. sqlite-jdbc answers a whole-schema
 * `getColumns()` by unioning one SELECT per column, and SQLite rejects a compound SELECT past 500
 * terms, so importing any schema wider than that failed with "too many terms in compound SELECT" and
 * no catalog at all. Found on a real Android sales-force database: 186 tables, 1777 columns, which is
 * ordinary for an app and 3.5x the ceiling. Every fixture here was far too small to reach it.
 */
class LargeSchemaTest {

    private fun open(build: (Connection) -> Unit): Connection {
        Class.forName("org.sqlite.JDBC")
        val file = File.createTempFile("asksql-large-", ".sqlite")
        file.deleteOnExit()
        val c = DriverManager.getConnection("jdbc:sqlite:${file.path}")
        build(c)
        return c
    }

    /** 60 tables x 12 columns = 720, comfortably past the 500-term ceiling. */
    @Test
    fun `a schema wider than the compound-select ceiling introspects whole`() {
        val c = open { conn ->
            conn.createStatement().use { st ->
                for (t in 0 until 60) {
                    val cols = (0 until 11).joinToString("") { ", c$it TEXT" }
                    st.execute("CREATE TABLE t$t (id INTEGER PRIMARY KEY$cols)")
                }
            }
        }
        val catalog = SqliteIntrospector.introspect(c, false)
        c.close()
        assertEquals(60, catalog.tables.size)
        assertEquals(720, catalog.tables.sumOf { it.columns.size })
        // Not merely present: every table keeps its full width, rather than a truncated prefix.
        for (table in catalog.tables) assertEquals(table.name, 12, table.columns.size)
    }

    /**
     * The per-table retry alone would not save this one: the ceiling is on TERMS, so a single table
     * past 500 columns breaches it in one call. Reading `PRAGMA table_info` instead has no ceiling.
     */
    @Test
    fun `one table wider than the ceiling introspects whole`() {
        val c = open { conn ->
            val cols = (0 until 600).joinToString("") { ", c$it TEXT" }
            conn.createStatement().use { st -> st.execute("CREATE TABLE wide (id INTEGER PRIMARY KEY$cols)") }
        }
        val catalog = SqliteIntrospector.introspect(c, false)
        c.close()
        assertEquals(601, catalog.tables.single().columns.size)
    }

    /** The column facts still have to be right, not just numerous. */
    @Test
    fun `columns keep their type, nullability and default`() {
        val c = open { conn ->
            conn.createStatement().use { st ->
                st.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT, qty INTEGER DEFAULT 7)")
            }
        }
        val cols = SqliteIntrospector.introspect(c, false).tables.single().columns.associateBy { it.name }
        c.close()
        assertEquals("TEXT", cols.getValue("name").dbType)
        assertEquals(false, cols.getValue("name").nullable)
        assertEquals(true, cols.getValue("note").nullable)
        assertEquals("7", cols.getValue("qty").default)
        assertEquals(setOf("id", "name", "note", "qty"), cols.keys)
    }

    /** A quoted or otherwise awkward table name must survive being pasted into a PRAGMA. */
    @Test
    fun `a table whose name needs quoting is read like any other`() {
        val c = open { conn ->
            conn.createStatement().use { st ->
                st.execute("""CREATE TABLE "odd ""name" (id INTEGER PRIMARY KEY, v TEXT)""")
                st.execute("""CREATE TABLE "order" (id INTEGER PRIMARY KEY, v TEXT)""")
            }
        }
        val catalog = SqliteIntrospector.introspect(c, false)
        c.close()
        for (table in catalog.tables) assertEquals(table.name, 2, table.columns.size)
    }
}
