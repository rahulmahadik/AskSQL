package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/core/test/catalog-answers.test.ts; the two must agree. */
class CatalogAnswersTest {

    private fun table(name: String, pk: List<String> = listOf("id"), kind: TableKind = TableKind.TABLE) = TableInfo(
        name = name,
        kind = kind,
        columns = listOf(ColumnInfo(name = "id", dbType = "int", nullable = false)),
        primaryKey = pk,
    )

    private val catalog = SchemaCatalog(
        engine = EngineKind.POSTGRES,
        tables = listOf(table("Orders"), table("Items", emptyList()), table("OrderView", emptyList(), TableKind.VIEW)),
    )

    private fun ask(q: String, dialect: com.rahulmahadik.asksql.ide.model.DialectInfo = Dialects.of(EngineKind.POSTGRES)) =
        CatalogAnswers.catalogQueryFor(q, catalog, dialect)

    @Test fun `answers the structure questions worth writing exactly`() {
        for (q in listOf(
            "how many rows are in each table?",
            "row counts per table",
            "which tables have the most rows?",
            "are there any tables without a primary key?",
            "which tables have no primary key?",
        )) {
            assertNotNull(q, ask(q))
        }
    }

    /** Hijacking a data question is far worse than missing a structure one. */
    @Test fun `leaves data questions to the model`() {
        for (q in listOf(
            "how many rows are in the orders table?",
            "show me all rows from orders",
            "which customers have no primary contact?",
            "how many orders are there?",
            "which order has the most items?",
            "list customers from the UK",
        )) {
            assertNull(q, ask(q))
        }
    }

    @Test fun `counts every base table and leaves views out`() {
        val sql = ask("how many rows are in each table?")!!.sql
        assertTrue(sql, sql.contains("\"Orders\""))
        assertTrue(sql, sql.contains("\"Items\""))
        assertFalse(sql, sql.contains("OrderView"))
    }

    @Test fun `orders the result when asked which is largest`() {
        assertTrue(ask("which tables have the most rows?")!!.sql.contains("ORDER BY row_count DESC"))
    }

    @Test fun `uses the dialect quote character`() {
        val sql = ask("how many rows are in each table?", Dialects.of(EngineKind.MYSQL))!!.sql
        assertTrue(sql, sql.contains("`Orders`"))
    }

    @Test fun `uses each engine's own catalog for the missing key query`() {
        assertTrue(ask("which tables have no primary key?")!!.sql.contains("information_schema.table_constraints"))
        assertTrue(
            ask("which tables have no primary key?", Dialects.of(EngineKind.MYSQL))!!.sql
                .contains("information_schema.TABLE_CONSTRAINTS"),
        )
        assertTrue(
            ask("which tables have no primary key?", Dialects.of(EngineKind.SQLITE))!!.sql.contains("pragma_table_info"),
        )
    }

    /** An engine with no shape written for it is left to the model rather than guessed at here. */
    @Test fun `declines an engine it has no query for`() {
        assertNull(ask("which tables have no primary key?", Dialects.of(EngineKind.DUCKDB)))
    }

    @Test fun `an empty catalog has nothing to count`() {
        val empty = SchemaCatalog(engine = EngineKind.POSTGRES, tables = emptyList())
        assertNull(CatalogAnswers.catalogQueryFor("how many rows are in each table?", empty, Dialects.of(EngineKind.POSTGRES)))
    }
}
