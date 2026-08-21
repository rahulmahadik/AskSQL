package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.test.IntegrationTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.sql.Connection
import java.sql.DriverManager

/**
 * A schema is not guaranteed to have keys or indexes at all. These assert what
 * [MysqlConstraints.load] must return for each shape, rather than only that it agrees with the
 * generic per-table path - if both dropped the same thing, a parity check alone would still pass.
 * Mirrors PostgresConstraintsShapesTest.
 */
@Category(IntegrationTest::class)
class MysqlConstraintsShapesTest {

    private val db = "asksql_mysql_shapes_test"
    private var available = false
    private var connection: Connection? = null

    private val fixture = """
        CREATE TABLE bare (a int, b text);
        CREATE TABLE pk_only (id int PRIMARY KEY);
        CREATE TABLE composite_pk (a int, b int, c text, PRIMARY KEY (a, b));
        CREATE TABLE composite_fk (x int, y int, FOREIGN KEY (x, y) REFERENCES composite_pk(a, b));
        CREATE TABLE two_fks (id int PRIMARY KEY, f1 int, f2 int, FOREIGN KEY (f1) REFERENCES pk_only(id), FOREIGN KEY (f2) REFERENCES pk_only(id));
        CREATE TABLE self_ref (id int PRIMARY KEY, parent int, FOREIGN KEY (parent) REFERENCES self_ref(id));
        CREATE TABLE idx_no_pk (v varchar(64));
        CREATE INDEX idx_no_pk_v ON idx_no_pk (v);
        CREATE TABLE fancy (id int PRIMARY KEY, status varchar(16), UNIQUE INDEX fancy_status_unique (status));
        CREATE VIEW a_view AS SELECT a FROM bare;
    """.trimIndent()

    @Before
    fun setUp() {
        connection = runCatching {
            DriverManager.getConnection("jdbc:mysql://127.0.0.1:3306/?allowPublicKeyRetrieval=true&useSSL=false", "root", "")
        }.getOrNull()
        available = connection != null
        if (!available) return
        connection!!.createStatement().use { st ->
            st.execute("DROP DATABASE IF EXISTS $db")
            st.execute("CREATE DATABASE $db")
            st.execute("USE $db")
            for (stmt in fixture.split(";\n")) if (stmt.isNotBlank()) st.execute(stmt)
        }
    }

    @After
    fun tearDown() {
        if (!available) return
        connection!!.createStatement().use { st -> st.execute("DROP DATABASE IF EXISTS $db") }
        connection!!.close()
    }

    @Test
    fun `every shape reports exactly what it has, including nothing at all`() {
        assumeTrue("no local MySQL on 3306", available)
        val c = connection!!
        val loaded = MysqlConstraints.load(c, db)
        assertTrue("batched load returned null", loaded != null)
        val pk = { t: String -> loaded!![null to t]?.primaryKey.orEmpty() }
        val fk = { t: String -> loaded!![null to t]?.foreignKeys.orEmpty() }
        val idx = { t: String -> loaded!![null to t]?.indexes.orEmpty() }

        // A table with nothing must report nothing, not a stale or missing entry.
        assertEquals("bare primary key", emptyList<String>(), pk("bare"))
        assertEquals("bare foreign keys", emptyList<Any>(), fk("bare"))
        assertEquals("bare indexes", emptyList<Any>(), idx("bare"))

        assertEquals("single-column pk", listOf("id"), pk("pk_only"))
        assertEquals("composite pk keeps its order", listOf("a", "b"), pk("composite_pk"))
        assertEquals("a table with no pk", emptyList<String>(), pk("idx_no_pk"))

        assertEquals("composite fk is one key over two columns", 1, fk("composite_fk").size)
        assertEquals(listOf("x", "y"), fk("composite_fk").first().columns)
        assertEquals(listOf("a", "b"), fk("composite_fk").first().refColumns)

        assertEquals("two separate fks to the same table", 2, fk("two_fks").size)
        assertEquals("a self-referencing fk", 1, fk("self_ref").size)
        assertEquals("self_ref", fk("self_ref").first().refTable)

        assertTrue("index on a table with no pk", idx("idx_no_pk").any { it.name == "idx_no_pk_v" })
        assertTrue("a unique index reports unique=true", idx("fancy").any { it.name == "fancy_status_unique" && it.unique })

        // A view has no keys or indexes of its own; absence must not become a null entry.
        assertEquals("view primary key", emptyList<String>(), pk("a_view"))
        assertEquals("view indexes", emptyList<Any>(), idx("a_view"))
    }
}
