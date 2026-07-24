package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Exercises [CatalogPruner] against schema shapes real production databases actually have: many tables, self-referencing and circular foreign keys, and composite (multi-column) relationships. */
class CatalogPrunerTest {

    private fun table(name: String, columns: List<String> = listOf("id"), foreignKeys: List<ForeignKeyInfo> = emptyList()) = TableInfo(
        name = name,
        kind = TableKind.TABLE,
        columns = columns.map { ColumnInfo(name = it, dbType = "int", nullable = false) },
        primaryKey = listOf("id"),
        foreignKeys = foreignKeys,
    )

    @Test fun `a large schema is pruned rather than blowing the token budget`() {
        val tables = (1..5000).map { table("table_$it") }
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = tables)

        val started = System.nanoTime()
        val result = CatalogPruner.pruneCatalog(catalog, "how many rows are in table_42")
        val elapsedMs = (System.nanoTime() - started) / 1_000_000

        assertTrue("expected pruning to keep well under the full 5000 tables", result.catalog.tables.size < 100)
        assertTrue("expected pruning of a 5000-table schema to complete quickly, took ${elapsedMs}ms", elapsedMs < 5000)
    }

    @Test fun `a self-referencing foreign key does not break pruning or the join graph`() {
        val employees = table(
            "employees", listOf("id", "manager_id"),
            foreignKeys = listOf(ForeignKeyInfo(columns = listOf("manager_id"), refTable = "employees", refColumns = listOf("id"))),
        )
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(employees))

        val edges = CatalogPruner.joinGraph(catalog)
        assertEquals(listOf("employees.manager_id = employees.id"), edges)

        val result = CatalogPruner.pruneCatalog(catalog, "who manages employee 5")
        assertEquals(1, result.catalog.tables.size)
    }

    @Test fun `a circular foreign key reference (A to B to C to A) does not infinite-loop`() {
        val a = table("a", listOf("id", "b_id"), listOf(ForeignKeyInfo(columns = listOf("b_id"), refTable = "b", refColumns = listOf("id"))))
        val b = table("b", listOf("id", "c_id"), listOf(ForeignKeyInfo(columns = listOf("c_id"), refTable = "c", refColumns = listOf("id"))))
        val c = table("c", listOf("id", "a_id"), listOf(ForeignKeyInfo(columns = listOf("a_id"), refTable = "a", refColumns = listOf("id"))))
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(a, b, c))

        val edges = CatalogPruner.joinGraph(catalog)
        assertEquals(3, edges.size)

        // Must terminate; this is the actual point of the test.
        val result = CatalogPruner.pruneCatalog(catalog, "show me a")
        assertTrue(result.catalog.tables.isNotEmpty())
    }

    @Test fun `two separate foreign keys from one table to the same referenced table are both represented`() {
        val addresses = table("addresses")
        val orders = table(
            "orders", listOf("id", "shipping_address_id", "billing_address_id"),
            foreignKeys = listOf(
                ForeignKeyInfo(columns = listOf("shipping_address_id"), refTable = "addresses", refColumns = listOf("id")),
                ForeignKeyInfo(columns = listOf("billing_address_id"), refTable = "addresses", refColumns = listOf("id")),
            ),
        )
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(addresses, orders))

        val edges = CatalogPruner.joinGraph(catalog).toSet()
        assertEquals(
            setOf(
                "orders.shipping_address_id = addresses.id",
                "orders.billing_address_id = addresses.id",
            ),
            edges,
        )
    }

    @Test fun `a composite multi-column foreign key renders both column pairs in order`() {
        val addresses = table("addresses", listOf("country", "region"))
        val orders = table(
            "orders", listOf("id", "ship_country", "ship_region"),
            foreignKeys = listOf(
                ForeignKeyInfo(columns = listOf("ship_country", "ship_region"), refTable = "addresses", refColumns = listOf("country", "region")),
            ),
        )
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(addresses, orders))

        val edges = CatalogPruner.joinGraph(catalog)
        assertEquals(listOf("orders.ship_country,ship_region = addresses.country,region"), edges)
    }

    @Test fun `joinGraph infers an edge from a _id column when no foreign key is declared`() {
        // Many real databases (e.g. MySQL with FK checks off) carry naming conventions but no
        // declared constraints; joinGraph recovers the join path from customer_id -> customers.id.
        val customers = table("customers")
        val orders = table("orders", listOf("id", "customer_id")) // no declared FK
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(customers, orders))

        val edges = CatalogPruner.joinGraph(catalog)
        assertTrue("expected an inferred edge, got $edges", edges.any { it.matches(Regex(".*orders\\.customer_id ~ .*customers\\.id.*inferred from naming.*")) })
    }

    @Test fun `joinGraph does not double-count an inferred edge that is already declared`() {
        val customers = table("customers")
        val orders = table("orders", listOf("id", "customer_id"), listOf(ForeignKeyInfo(columns = listOf("customer_id"), refTable = "customers", refColumns = listOf("id"))))
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(customers, orders))

        val orderEdges = CatalogPruner.joinGraph(catalog).filter { it.contains("orders.customer_id") }
        assertEquals(1, orderEdges.size)
        assertTrue("declared FK must not be tagged inferred", !orderEdges.first().contains("inferred"))
    }

    @Test fun `pruning includes a seed table's FK neighbors even when the neighbor itself matches no search term`() {
        val addresses = table("addresses", listOf("id", "unrelated_column_name"))
        val orders = table(
            "orders", listOf("id", "address_id"),
            foreignKeys = listOf(ForeignKeyInfo(columns = listOf("address_id"), refTable = "addresses", refColumns = listOf("id"))),
        )
        // Enough padding tables that pruning actually kicks in.
        val padding = (1..50).map { table("padding_$it") }
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(orders, addresses) + padding)

        val result = CatalogPruner.pruneCatalog(catalog, "show me all orders")
        val keptNames = result.catalog.tables.map { it.name }.toSet()
        assertTrue("expected the matched seed table 'orders' to be kept", keptNames.contains("orders"))
        assertTrue("expected 'addresses' to be pulled in as orders' FK neighbor even though it matches no search term", keptNames.contains("addresses"))
    }

    @Test fun `a multi-hop join chain is fully captured from a single matched seed`() {
        // orders -> customers -> regions; only "orders" matches the question, but a many-join answer needs all three.
        val orders = table("orders", listOf("id", "customer_id"), listOf(ForeignKeyInfo(columns = listOf("customer_id"), refTable = "customers", refColumns = listOf("id"))))
        val customers = table("customers", listOf("id", "region_id"), listOf(ForeignKeyInfo(columns = listOf("region_id"), refTable = "regions", refColumns = listOf("id"))))
        val regions = table("regions", listOf("id", "unrelated"))
        val padding = (1..60).map { table("padding_$it") }
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(orders, customers, regions) + padding)

        val kept = CatalogPruner.pruneCatalog(catalog, "show me all orders").catalog.tables.map { it.name }.toSet()
        assertTrue("seed 'orders' kept", kept.contains("orders"))
        assertTrue("1-hop 'customers' kept", kept.contains("customers"))
        assertTrue("2-hop 'regions' kept (multi-hop closure)", kept.contains("regions"))
    }

    @Test fun `snake_case column words are matched by a bare question term`() {
        val lineItems = table("line_items", listOf("id", "unit_price_cents"))
        val misc = table("misc", listOf("id", "note"))
        val padding = (1..60).map { table("padding_$it") }
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(lineItems, misc) + padding)

        val kept = CatalogPruner.pruneCatalog(catalog, "what is the total price").catalog.tables.map { it.name }.toSet()
        assertTrue("'line_items' kept because its unit_price_cents column tokenizes to include 'price'", kept.contains("line_items"))
    }

    // ---- Sample/enum value sanitization; these come from live row data (or, for Mongo, an
    // unbounded value.toString()), not schema metadata, so nothing upstream guarantees they're
    // short or free of whitespace/separator characters. ----

    @Test fun `a sample value containing a newline does not break the one-line-per-column format`() {
        val orders = TableInfo(
            name = "orders", kind = TableKind.TABLE,
            columns = listOf(ColumnInfo(name = "note", dbType = "text", nullable = true, sampledValues = listOf("line one\nline two"))),
        )
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(orders))
        val text = CatalogPruner.formatCatalogForPrompt(catalog)
        assertTrue(text.contains("line one line two"))
        assertEquals("expected exactly 2 lines (the TABLE header and the one column line)", 2, text.lines().size)
    }

    @Test fun `a sample value containing a literal pipe does not merge with the next value`() {
        val orders = TableInfo(
            name = "orders", kind = TableKind.TABLE,
            columns = listOf(ColumnInfo(name = "code", dbType = "text", nullable = true, sampledValues = listOf("a|b", "c"))),
        )
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(orders))
        val text = CatalogPruner.formatCatalogForPrompt(catalog)
        assertTrue("expected the literal '|' inside the value to be replaced, not read as the value separator", text.contains("a/b|c"))
    }

    @Test fun `an extremely long sample value is capped rather than blowing the token budget`() {
        val orders = TableInfo(
            name = "orders", kind = TableKind.TABLE,
            columns = listOf(ColumnInfo(name = "blob", dbType = "text", nullable = true, sampledValues = listOf("x".repeat(5000)))),
        )
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = listOf(orders))
        val text = CatalogPruner.formatCatalogForPrompt(catalog)
        assertTrue("expected the value to be capped, not rendered at its full 5000-char length", text.length < 500)
    }

    /** The pruner's per-table budget must count sample-value characters, not just column names, or a schema with long sample values can blow `maxSchemaTokens` while undercounting the estimated cost. */
    @Test fun `pruning a schema with heavy sample values keeps the rendered text within the token budget`() {
        // Every table matches the search term, is trimmed only by the
        // per-table token budget (not maxTables; there are only 30 of
        // them); a small maxSchemaTokens forces the budget accounting to
        // actually matter for how many get kept.
        val heavyTables = (1..30).map { i ->
            TableInfo(
                name = "widget_$i", kind = TableKind.TABLE,
                columns = listOf(
                    ColumnInfo(
                        name = "description", dbType = "text", nullable = true,
                        sampledValues = (1..24).map { "a fairly long sample value that is representative of real string data $it" },
                    ),
                ),
            )
        }
        val catalog = SchemaCatalog(engine = EngineKind.POSTGRES, tables = heavyTables)
        val settings = CatalogPruner.PrunerSettings(maxTables = 100, maxSchemaTokens = 2000)

        val result = CatalogPruner.pruneCatalog(catalog, "widget", settings)

        val actualTokens = CatalogPruner.estimateTokens(result.schemaText)
        assertTrue(
            "expected the pruner's own budget accounting to keep the rendered text close to maxSchemaTokens (2000), got $actualTokens tokens for ${result.catalog.tables.size} tables",
            actualTokens < settings.maxSchemaTokens + 500,
        )
    }
}
