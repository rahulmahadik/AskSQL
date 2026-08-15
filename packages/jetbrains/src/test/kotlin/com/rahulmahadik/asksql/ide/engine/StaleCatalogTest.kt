package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/core/test/stale-catalog.test.ts. */
class StaleCatalogTest {

    private val customersOnly = SchemaCatalog(
        engine = EngineKind.POSTGRES,
        tables = listOf(
            TableInfo(
                name = "customers",
                kind = TableKind.TABLE,
                columns = listOf(
                    ColumnInfo(name = "CustomerId", dbType = "int", nullable = false),
                    ColumnInfo(name = "Name", dbType = "text", nullable = true),
                ),
            ),
        ),
    )

    @Test fun `recognises a question about something it holds`() {
        for (q in listOf(
            "how many customers are there?",
            "list the names",
            "show me every customer",
            "what is the CustomerId of Ada?",
        )) {
            assertTrue(q, SchemaFuzzyMatch.namesSomethingInCatalog(q, customersOnly))
        }
    }

    /** These name a relation the catalog has never heard of, which is the stale case. */
    @Test fun `does not recognise a relation it has never seen`() {
        for (q in listOf("how many invoices are there?", "show me the shipments", "total revenue per warehouse")) {
            assertFalse(q, SchemaFuzzyMatch.namesSomethingInCatalog(q, customersOnly))
        }
    }

    @Test fun `says yes when there is nothing to match against`() {
        val empty = SchemaCatalog(engine = EngineKind.POSTGRES, tables = emptyList())
        assertTrue(SchemaFuzzyMatch.namesSomethingInCatalog("anything at all", empty))
    }
}
