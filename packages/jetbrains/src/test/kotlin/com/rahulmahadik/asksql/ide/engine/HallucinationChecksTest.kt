package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.guard.SqlGuard
import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.GuardPolicy
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** [HallucinationChecks] uses JSqlParser (not core's `node-sql-parser`) for structural extraction, so these tests verify the documented behavior directly: fail-open on ambiguity, catch confidently-wrong names. */
class HallucinationChecksTest {

    private val catalog = SchemaCatalog(
        engine = EngineKind.POSTGRES,
        tables = listOf(
            TableInfo(
                name = "customers",
                kind = TableKind.TABLE,
                columns = listOf(
                    ColumnInfo(name = "id", dbType = "integer", nullable = false),
                    ColumnInfo(name = "name", dbType = "text", nullable = false),
                ),
            ),
            TableInfo(
                name = "orders",
                kind = TableKind.TABLE,
                columns = listOf(
                    ColumnInfo(name = "id", dbType = "integer", nullable = false),
                    ColumnInfo(name = "customer_id", dbType = "integer", nullable = false),
                ),
            ),
        ),
    )

    private fun tablesOf(sql: String) = SqlGuard.guard(sql, Dialects.POSTGRES, GuardPolicy.DEFAULT).tables

    @Test
    fun `flags a table that does not exist in the catalog`() {
        val sql = "SELECT * FROM invoices"
        assertEquals("invoices", HallucinationChecks.firstUnknownTable(sql, catalog, tablesOf(sql)))
    }

    @Test
    fun `does not flag a real table`() {
        val sql = "SELECT * FROM customers"
        assertNull(HallucinationChecks.firstUnknownTable(sql, catalog, tablesOf(sql)))
    }

    @Test
    fun `a CTE name is not treated as an unknown table`() {
        val sql = "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent"
        assertNull(HallucinationChecks.firstUnknownTable(sql, catalog, tablesOf(sql)))
    }

    @Test
    fun `flags a column that does not exist on a known table`() {
        val sql = "SELECT email FROM customers"
        val unknown = HallucinationChecks.firstUnknownColumn(sql, catalog)
        assertEquals("customers", unknown?.table)
        assertEquals("email", unknown?.column)
        assertEquals(listOf("id", "name"), unknown?.available)
    }

    @Test
    fun `does not flag a real column`() {
        assertNull(HallucinationChecks.firstUnknownColumn("SELECT name FROM customers", catalog))
    }

    @Test
    fun `does not flag columns behind a subquery - fails open on ambiguity`() {
        // The outer query's column can't be confidently attributed once a
        // subquery is involved, so this must never produce a false positive.
        val sql = "SELECT x.total FROM (SELECT customer_id AS total FROM orders) x"
        assertNull(HallucinationChecks.firstUnknownColumn(sql, catalog))
    }

    @Test
    fun `SELECT star never triggers a column hallucination`() {
        assertNull(HallucinationChecks.firstUnknownColumn("SELECT * FROM customers", catalog))
    }

    @Test
    fun `a qualified column on a known table alias is checked correctly`() {
        val unknown = HallucinationChecks.firstUnknownColumn("SELECT c.phone FROM customers c", catalog)
        assertEquals("customers", unknown?.table)
        assertEquals("phone", unknown?.column)
    }

    // ---- Quoted identifiers (JSqlParser preserves the quote characters; must be stripped before comparing to the catalog) ----

    @Test
    fun `a double-quoted real table name is not flagged as unknown`() {
        val sql = """SELECT * FROM "customers""""
        assertNull(HallucinationChecks.firstUnknownTable(sql, catalog, tablesOf(sql)))
    }

    @Test
    fun `a backtick-quoted real column name is not flagged as unknown`() {
        assertNull(HallucinationChecks.firstUnknownColumn("SELECT `name` FROM `customers`", catalog))
    }

    @Test
    fun `a double-quoted real column name is not flagged as unknown`() {
        assertNull(HallucinationChecks.firstUnknownColumn("""SELECT "name" FROM customers""", catalog))
    }

    @Test
    fun `a quoted qualified column on a quoted table alias is checked correctly`() {
        assertNull(HallucinationChecks.firstUnknownColumn("""SELECT "c"."name" FROM "customers" "c"""", catalog))
    }

    @Test
    fun `a quoted column that genuinely does not exist is still flagged`() {
        val unknown = HallucinationChecks.firstUnknownColumn("""SELECT "email" FROM customers""", catalog)
        assertEquals("customers", unknown?.table)
        assertEquals("email", unknown?.column)
    }
}
