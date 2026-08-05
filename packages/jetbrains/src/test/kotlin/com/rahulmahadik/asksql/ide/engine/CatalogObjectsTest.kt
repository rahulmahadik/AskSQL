package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.EnumTypeInfo
import com.rahulmahadik.asksql.ide.model.IndexInfo
import com.rahulmahadik.asksql.ide.model.RoutineInfo
import com.rahulmahadik.asksql.ide.model.RoutineKind
import com.rahulmahadik.asksql.ide.model.RoutineVolatility
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.SequenceInfo
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import com.rahulmahadik.asksql.ide.model.TriggerInfo
import com.rahulmahadik.asksql.ide.model.TriggerTiming
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin half of core's `catalog-objects.test.ts`. A DBA question about indexes, triggers,
 * procedures or sequences can only be answered if those objects reach the prompt.
 */
class CatalogObjectsTest {

    private fun table(name: String, indexes: List<IndexInfo> = emptyList()) = TableInfo(
        schema = "shop",
        name = name,
        kind = TableKind.TABLE,
        columns = listOf(ColumnInfo(name = "id", dbType = "bigint", nullable = false)),
        primaryKey = listOf("id"),
        indexes = indexes,
    )

    private val catalog = SchemaCatalog(
        engine = EngineKind.POSTGRES,
        schemas = listOf("shop"),
        tables = listOf(
            table(
                "orders",
                listOf(
                    IndexInfo(name = "orders_pkey", columns = listOf("id"), unique = true),
                    IndexInfo(name = "orders_customer_idx", columns = listOf("customer_id"), unique = false),
                    IndexInfo(name = "orders_open_idx", columns = listOf("status"), unique = false, predicate = "status = 'open'"),
                ),
            ),
            table("customers"),
        ),
        enums = listOf(EnumTypeInfo(name = "order_status", values = listOf("pending", "paid"))),
        sequences = listOf(SequenceInfo(schema = "shop", name = "orders_id_seq")),
        triggers = listOf(
            TriggerInfo("orders_audit", "shop", "orders", TriggerTiming.AFTER, listOf("INSERT", "UPDATE"), true),
            TriggerInfo("orders_stale", "shop", "orders", TriggerTiming.BEFORE, listOf("DELETE"), false),
        ),
        routines = listOf(
            RoutineInfo(schema = "shop", name = "recalc_totals", kind = RoutineKind.PROCEDURE, args = "oid bigint", volatility = RoutineVolatility.VOLATILE),
            RoutineInfo(
                schema = "shop", name = "order_count", kind = RoutineKind.FUNCTION,
                args = "cid bigint", returns = "bigint", volatility = RoutineVolatility.STABLE,
            ),
        ),
    )

    private val text = CatalogPruner.formatCatalogForPrompt(catalog)

    @Test
    fun `indexes are named per table`() {
        assertTrue(text.contains("orders_customer_idx(customer_id)"))
        assertTrue(text.contains("orders_pkey(id) UNIQUE"))
    }

    /** A partial index is marked, not pasted: the predicate is data written by someone else. */
    @Test
    fun `a partial index is marked without its predicate`() {
        assertTrue(text.contains("orders_open_idx(status) WHERE ..."))
        assertFalse(text.contains("status = 'open'"))
    }

    @Test
    fun `triggers carry their timing, events and table`() {
        assertTrue(text.contains("orders_audit AFTER INSERT/UPDATE ON shop.orders"))
        assertTrue(text.contains("orders_stale BEFORE DELETE ON shop.orders [disabled]"))
    }

    @Test
    fun `procedures are listed for reference, never as callable`() {
        assertTrue(text.contains("STORED PROCEDURES (reference only - NEVER call these"))
        assertTrue(text.contains("recalc_totals(oid bigint)"))
        assertFalse(text.substringAfter("CALLABLE READ-ONLY FUNCTIONS").contains("recalc_totals"))
    }

    @Test
    fun `sequences and enums are listed`() {
        assertTrue(text.contains("SEQUENCES: orders_id_seq"))
        assertTrue(text.contains("order_status: pending|paid"))
    }

    @Test
    fun `a database without these objects says nothing about them`() {
        val bare = CatalogPruner.formatCatalogForPrompt(
            catalog.copy(triggers = emptyList(), sequences = emptyList(), routines = emptyList(), tables = listOf(table("orders"))),
        )
        assertFalse(bare.contains("TRIGGERS:"))
        assertFalse(bare.contains("SEQUENCES:"))
        assertFalse(bare.contains("STORED PROCEDURES"))
        assertFalse(bare.contains("INDEXES:"))
    }
}
