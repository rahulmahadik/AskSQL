package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.test.IntegrationTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.experimental.categories.Category
import java.sql.Connection
import java.sql.DriverManager

/**
 * A schema is not guaranteed to have keys or indexes at all. These assert what the batched loader
 * must return for each shape, rather than only that it agrees with the per-table path: if both
 * dropped the same thing, a parity check would still pass.
 */
@Category(IntegrationTest::class)
class PostgresConstraintsShapesTest {

    private fun connect(): Connection? =
        runCatching { DriverManager.getConnection("jdbc:postgresql://localhost:5432/asksql_test", "postgres", "root") }
            .getOrNull()

    private val fixture = """
        DROP SCHEMA IF EXISTS shapes CASCADE;
        CREATE SCHEMA shapes;
        CREATE TABLE shapes.bare (a int, b text);
        CREATE TABLE shapes.pk_only (id int PRIMARY KEY);
        CREATE TABLE shapes.composite_pk (a int, b int, c text, PRIMARY KEY (a, b));
        CREATE TABLE shapes.composite_fk (x int, y int, FOREIGN KEY (x, y) REFERENCES shapes.composite_pk(a, b));
        CREATE TABLE shapes.two_fks (f1 int REFERENCES shapes.pk_only(id), f2 int REFERENCES shapes.pk_only(id));
        CREATE TABLE shapes.self_ref (id int PRIMARY KEY, parent int REFERENCES shapes.self_ref(id));
        CREATE TABLE shapes.idx_no_pk (v text);
        CREATE INDEX idx_no_pk_v ON shapes.idx_no_pk (v);
        CREATE TABLE shapes.fancy (id int PRIMARY KEY, email text, status text);
        CREATE INDEX fancy_lower_email ON shapes.fancy (lower(email));
        CREATE INDEX fancy_active ON shapes.fancy (status) WHERE status = 'active';
        CREATE VIEW shapes.a_view AS SELECT a FROM shapes.bare;
    """.trimIndent()

    @Test
    fun `every shape reports exactly what it has, including nothing at all`() {
        val connection = connect() ?: run {
            println("[skip] constraint shapes - no local Postgres on 5432")
            return
        }
        connection.use { c ->
            c.createStatement().use { st -> for (stmt in fixture.split(";\n")) if (stmt.isNotBlank()) st.execute(stmt) }
            try {
                val loaded = PostgresConstraints.load(c)
                assertTrue("batched load returned null", loaded != null)
                val pk = { t: String -> loaded!!.primaryKeys["shapes" to t].orEmpty() }
                val fk = { t: String -> loaded!!.foreignKeys["shapes" to t].orEmpty() }
                val idx = { t: String -> loaded!!.indexes["shapes" to t].orEmpty() }

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
                assertTrue("expression index carries its expression", idx("fancy").any { it.columns.any { c -> c.contains("lower") } })
                assertTrue("partial index is still listed", idx("fancy").any { it.name == "fancy_active" })

                // A view has no keys or indexes of its own; absence must not become a null entry.
                assertEquals("view primary key", emptyList<String>(), pk("a_view"))
                assertEquals("view indexes", emptyList<Any>(), idx("a_view"))
            } finally {
                c.createStatement().use { st -> st.execute("DROP SCHEMA IF EXISTS shapes CASCADE") }
            }
        }
    }
}
