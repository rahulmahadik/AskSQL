package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.db.DriverProvisioner
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.experimental.categories.Category
import java.sql.Connection
import java.util.Properties

/**
 * A schema is not guaranteed to have keys or indexes at all. These assert what
 * [OracleConstraints.load] must return for each shape, rather than only that it agrees with the
 * generic per-table path - if both dropped the same thing, a parity check alone would still pass.
 * Mirrors PostgresConstraintsShapesTest / MysqlConstraintsShapesTest. Needs a local Oracle on 1521
 * with an `asksql`/`asksql` user (see internal/LOCAL-DBS.md); skips otherwise.
 */
@Category(IntegrationTest::class)
class OracleConstraintsShapesTest {

    private val owner = "ASKSQL"
    private val prefix = "SHT_" // short: Oracle identifiers cap at 30 chars

    private val fixture = listOf(
        "CREATE TABLE ${prefix}bare (a NUMBER, b VARCHAR2(64))",
        "CREATE TABLE ${prefix}pk_only (id NUMBER PRIMARY KEY)",
        "CREATE TABLE ${prefix}composite_pk (a NUMBER, b NUMBER, c VARCHAR2(64), CONSTRAINT ${prefix}cpk PRIMARY KEY (a, b))",
        "CREATE TABLE ${prefix}composite_fk (x NUMBER, y NUMBER, CONSTRAINT ${prefix}cfk FOREIGN KEY (x, y) REFERENCES ${prefix}composite_pk(a, b))",
        "CREATE TABLE ${prefix}two_fks (id NUMBER PRIMARY KEY, f1 NUMBER, f2 NUMBER, CONSTRAINT ${prefix}f1 FOREIGN KEY (f1) REFERENCES ${prefix}pk_only(id), CONSTRAINT ${prefix}f2 FOREIGN KEY (f2) REFERENCES ${prefix}pk_only(id))",
        "CREATE TABLE ${prefix}self_ref (id NUMBER PRIMARY KEY, parent NUMBER, CONSTRAINT ${prefix}sr FOREIGN KEY (parent) REFERENCES ${prefix}self_ref(id))",
        "CREATE TABLE ${prefix}idx_no_pk (v VARCHAR2(64))",
        "CREATE INDEX ${prefix}idx_no_pk_v ON ${prefix}idx_no_pk (v)",
        "CREATE TABLE ${prefix}fancy (id NUMBER PRIMARY KEY, status VARCHAR2(16))",
        "CREATE UNIQUE INDEX ${prefix}fancy_status_uq ON ${prefix}fancy (status)",
        "CREATE VIEW ${prefix}a_view AS SELECT a FROM ${prefix}bare",
    )

    private fun connect(): Connection? = runCatching {
        val driver = kotlinx.coroutines.runBlocking { DriverProvisioner.oracleDriver() }
        driver.connect(
            "jdbc:oracle:thin:@//127.0.0.1:1521/FREEPDB1",
            Properties().apply { setProperty("user", "asksql"); setProperty("password", "asksql") },
        )
    }.getOrNull()

    @Test
    fun `every shape reports exactly what it has, including nothing at all`() = runTest(timeout = kotlin.time.Duration.parse("2m")) {
        val c = connect() ?: run {
            println("[skip] Oracle constraint shapes - no local Oracle on 1521")
            return@runTest
        }
        c.use { connection ->
            connection.createStatement().use { st ->
                for (table in listOf("bare", "pk_only", "composite_pk", "composite_fk", "two_fks", "self_ref", "idx_no_pk", "fancy")) {
                    runCatching { st.execute("DROP TABLE $prefix$table CASCADE CONSTRAINTS") }
                }
                runCatching { st.execute("DROP VIEW ${prefix}a_view") }
                for (stmt in fixture) st.execute(stmt)
            }
            try {
                val loaded = OracleConstraints.load(connection, owner)
                assertTrue("batched load returned null", loaded != null)
                val pk = { t: String -> loaded!![owner to "$prefix$t".uppercase()]?.primaryKey.orEmpty() }
                val fk = { t: String -> loaded!![owner to "$prefix$t".uppercase()]?.foreignKeys.orEmpty() }
                val idx = { t: String -> loaded!![owner to "$prefix$t".uppercase()]?.indexes.orEmpty() }

                // A table with nothing must report nothing, not a stale or missing entry.
                assertEquals("bare primary key", emptyList<String>(), pk("bare"))
                assertEquals("bare foreign keys", emptyList<Any>(), fk("bare"))
                assertEquals("bare indexes", emptyList<Any>(), idx("bare"))

                assertEquals("single-column pk", listOf("ID"), pk("pk_only"))
                assertEquals("composite pk keeps its order", listOf("A", "B"), pk("composite_pk"))
                assertEquals("a table with no pk", emptyList<String>(), pk("idx_no_pk"))

                assertEquals("composite fk is one key over two columns", 1, fk("composite_fk").size)
                assertEquals(listOf("X", "Y"), fk("composite_fk").first().columns)
                assertEquals(listOf("A", "B"), fk("composite_fk").first().refColumns)

                assertEquals("two separate fks to the same table", 2, fk("two_fks").size)
                assertEquals("a self-referencing fk", 1, fk("self_ref").size)
                assertTrue("self_ref".uppercase() in fk("self_ref").first().refTable.uppercase())

                assertTrue("index on a table with no pk", idx("idx_no_pk").any { it.name.uppercase() == "${prefix}IDX_NO_PK_V".uppercase() })
                assertTrue("a unique index reports unique=true", idx("fancy").any { it.name.uppercase() == "${prefix}FANCY_STATUS_UQ".uppercase() && it.unique })

                // A view has no keys or indexes of its own; absence must not become a null entry.
                assertEquals("view primary key", emptyList<String>(), pk("a_view"))
                assertEquals("view indexes", emptyList<Any>(), idx("a_view"))
            } finally {
                connection.createStatement().use { st ->
                    for (table in listOf("bare", "pk_only", "composite_pk", "composite_fk", "two_fks", "self_ref", "idx_no_pk", "fancy")) {
                        runCatching { st.execute("DROP TABLE $prefix$table CASCADE CONSTRAINTS") }
                    }
                    runCatching { st.execute("DROP VIEW ${prefix}a_view") }
                }
            }
        }
    }
}
