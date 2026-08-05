package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.guard.SqlGuard
import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin half of core's `spreadsheet-identifiers.test.ts`. A CSV exported from a spreadsheet
 * has headers like `Order Status`; a model copies the schema verbatim, so the prompt has to show
 * the quoted form, and the guard has to catch the MySQL backticks a model reaches for out of habit.
 */
class SpreadsheetIdentifierTest {

    private fun catalog(engine: EngineKind, table: String, columns: List<String>) = SchemaCatalog(
        engine = engine,
        schemas = emptyList(),
        tables = listOf(
            TableInfo(
                name = table,
                schema = null,
                kind = TableKind.TABLE,
                columns = columns.map { ColumnInfo(name = it, dbType = "VARCHAR", nullable = true) },
                primaryKey = emptyList(),
                foreignKeys = emptyList(),
            ),
        ),
        enums = emptyList(),
        sequences = emptyList(),
        triggers = emptyList(),
        routines = emptyList(),
        warnings = emptyList(),
        fetchedAt = java.time.Instant.EPOCH,
    )

    @Test
    fun `a header with a space is shown quoted`() {
        val text = CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.DUCKDB, "orders", listOf("Order ID", "Order Status", "Notes")))
        assertTrue(text, text.contains("\"Order ID\""))
        assertTrue(text, text.contains("\"Order Status\""))
        // A plain word stays bare, so ordinary schemas read exactly as before.
        assertTrue(text, text.contains(" Notes "))
        assertFalse(text, text.contains("\"Notes\""))
    }

    @Test
    fun `the dialect's own quote character is used`() {
        val text = CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.MYSQL, "orders", listOf("Order Status")))
        assertTrue(text, text.contains("`Order Status`"))
    }

    @Test
    fun `a table name that needs quoting gets it`() {
        val text = CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.DUCKDB, "sales report", listOf("id")))
        assertTrue(text, text.contains("\"sales report\""))
    }

    /** MongoDB has no SQL dialect; the shared formatter must not reach for one. */
    @Test
    fun `a document catalog renders without a SQL dialect`() {
        val text = CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.MONGODB, "orders", listOf("_id", "Order Status")))
        assertTrue(text, text.contains("\"Order Status\""))
    }

    @Test
    fun `backticks are blocked on every dialect but MySQL`() {
        for (dialect in listOf(Dialects.POSTGRES, Dialects.DUCKDB, Dialects.SQLITE, Dialects.ORACLE)) {
            val verdict = SqlGuard.guard("SELECT `Customer Name` FROM orders", dialect)
            assertFalse(dialect.promptLabel, verdict.allowed)
            assertEquals("backtick_identifier", verdict.ruleId)
            // The reason names the right quote character: it IS the repair instruction.
            assertTrue(verdict.reason, verdict.reason!!.contains(dialect.quoteChar))
        }
    }

    @Test
    fun `backticks are allowed on MySQL, where they are correct`() {
        assertTrue(SqlGuard.guard("SELECT `Customer Name` FROM orders", Dialects.MYSQL).allowed)
    }

    @Test
    fun `a backtick inside a string literal is not an identifier`() {
        assertTrue(SqlGuard.guard("SELECT id FROM orders WHERE notes = 'has a ` in it'", Dialects.POSTGRES).allowed)
    }

    /**
     * The lexer, not a regex over raw text, decides what is a literal. A backtick inside a comment
     * or a dollar-quoted string is not an identifier, and an apostrophe in a comment must not pair
     * with a later literal's opening quote and swallow a real one.
     */
    @Test
    fun `only a real backtick identifier trips the rule`() {
        val allowed = listOf(
            "SELECT id FROM t -- see the `status` column",
            "SELECT id FROM t /* the `status` column */ WHERE id = 1",
            "SELECT id FROM t WHERE note = 'has a ` tick'",
            "SELECT id FROM t WHERE note = 'it''s got a ` tick'",
        )
        for (sql in allowed) {
            assertTrue(sql, SqlGuard.guard(sql, Dialects.POSTGRES).allowed)
        }
        // An apostrophe in a comment must not hide the backtick identifier that follows.
        val blocked = "SELECT a -- don't\n, `col` FROM t"
        assertFalse(blocked, SqlGuard.guard(blocked, Dialects.POSTGRES).allowed)
    }


    /** An unquoted name folds case: PostgreSQL to lower, Oracle to upper. */
    @Test
    fun `mixed case is quoted where the engine folds it`() {
        assertTrue(CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.POSTGRES, "t", listOf("OrderDate"))).contains("\"OrderDate\""))
        assertTrue(CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.ORACLE, "t", listOf("order_date"))).contains("\"order_date\""))
        assertTrue(CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.ORACLE, "t", listOf("ORDER_DATE"))).contains(" ORDER_DATE "))
        // SQLite, DuckDB and MySQL match identifiers case-insensitively.
        assertTrue(CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.SQLITE, "t", listOf("OrderDate"))).contains(" OrderDate "))
    }

    @Test
    fun `a reserved word used as a column name is quoted`() {
        for (word in listOf("order", "group", "user", "from", "desc", "check")) {
            val text = CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.POSTGRES, "t", listOf(word)))
            assertTrue(word, text.contains("\"" + word + "\""))
        }
    }

    @Test
    fun `the quote character inside a name is escaped`() {
        val text = CatalogPruner.formatCatalogForPrompt(catalog(EngineKind.POSTGRES, "t", listOf("we\"ird")))
        assertTrue(text, text.contains("\"we\"\"ird\""))
    }

}
