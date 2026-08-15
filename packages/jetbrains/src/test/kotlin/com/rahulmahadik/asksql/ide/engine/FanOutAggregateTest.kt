package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors the fan-out tests in packages/core: an inflated SUM the guard cannot see. */
class FanOutAggregateTest {

    private val catalog = SchemaCatalog(
        engine = com.rahulmahadik.asksql.ide.model.EngineKind.POSTGRES,
        tables = listOf(
            TableInfo(
                name = "orders",
                kind = com.rahulmahadik.asksql.ide.model.TableKind.TABLE,
                columns = listOf(ColumnInfo(name = "id", dbType = "int", nullable = false), ColumnInfo(name = "total", dbType = "numeric", nullable = false)),
                primaryKey = listOf("id"),
            ),
            TableInfo(
                name = "order_items",
                kind = com.rahulmahadik.asksql.ide.model.TableKind.TABLE,
                columns = listOf(ColumnInfo(name = "id", dbType = "int", nullable = false), ColumnInfo(name = "order_id", dbType = "int", nullable = false)),
                foreignKeys = listOf(ForeignKeyInfo(columns = listOf("order_id"), refTable = "orders", refColumns = listOf("id"))),
            ),
        ),
    )

    @Test
    fun `flags a SUM over a one-to-many join`() {
        val found = Semantics.fanOutAggregate(
            "SELECT SUM(o.total) FROM orders o JOIN order_items i ON i.order_id = o.id",
            catalog,
        )
        assertEquals("total", found?.column)
        assertEquals("orders", found?.parent)
        assertEquals("order_items", found?.child)
    }

    @Test
    fun `leaves a single-table SUM and an unrelated join alone`() {
        assertNull(Semantics.fanOutAggregate("SELECT SUM(total) FROM orders", catalog))
        assertNull(Semantics.fanOutAggregate("SELECT SUM(i.id) FROM order_items i", catalog))
    }
}
