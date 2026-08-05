package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin half of core's `very-large-schema.test.ts`. A large database must still produce a
 * prompt a model can read, and one very wide table must not defeat the budget on its own.
 */
class VeryLargeSchemaTest {

    private val budget = 6000

    private fun table(i: Int, columns: Int = 12, fks: List<ForeignKeyInfo> = emptyList()) = TableInfo(
        schema = "app",
        name = "table_$i",
        kind = TableKind.TABLE,
        columns = (0 until columns).map {
            ColumnInfo(name = if (it == 0) "id" else "column_number_$it", dbType = "character varying(255)", nullable = it != 0)
        },
        primaryKey = listOf("id"),
        foreignKeys = fks,
    )

    private fun catalog(tables: List<TableInfo>) =
        SchemaCatalog(engine = EngineKind.POSTGRES, schemas = listOf("app"), tables = tables)

    private fun settings() = CatalogPruner.PrunerSettings(maxSchemaTokens = budget)

    private fun tokens(text: String) = kotlin.math.ceil(text.length / 4.0).toInt()

    @Test
    fun `a large schema prunes under the token budget`() {
        for (count in listOf(200, 1000, 5000)) {
            val cat = catalog((0 until count).map { table(it) })
            val pruned = CatalogPruner.pruneCatalog(cat, "how many rows are in table_7 by column_number_3", settings())
            assertTrue("$count tables: ${tokens(pruned.schemaText)} tokens", tokens(pruned.schemaText) <= budget)
            assertTrue("table_7 must survive", pruned.catalog.tables.any { it.name == "table_7" })
        }
    }

    @Test
    fun `a question matching nothing still yields a bounded prompt`() {
        val cat = catalog((0 until 1000).map { table(it) })
        val pruned = CatalogPruner.pruneCatalog(cat, "zzzz nothing matches this at all", settings())
        assertTrue(pruned.catalog.tables.isNotEmpty())
        assertTrue(tokens(pruned.schemaText) <= budget)
    }

    private fun wide() = catalog(
        listOf(table(0, columns = 800, fks = listOf(ForeignKeyInfo(columns = listOf("column_number_5"), refTable = "other", refColumns = listOf("id"))))),
    )

    @Test
    fun `one very wide table is trimmed rather than giving up`() {
        val pruned = CatalogPruner.pruneCatalog(wide(), "count rows", settings())
        assertTrue(tokens(pruned.schemaText) <= budget)
        assertTrue(pruned.catalog.tables[0].columns.size < 800)
    }

    /** Keys carry the joins, so they survive the cut whatever else does not. */
    @Test
    fun `trimming keeps the keys and a column the question names`() {
        val kept = CatalogPruner.pruneCatalog(wide(), "count rows", settings()).catalog.tables[0].columns.map { it.name }
        assertTrue(kept.contains("id"))
        assertTrue(kept.contains("column_number_5"))
        val named = CatalogPruner.pruneCatalog(wide(), "what is in column_number_700", settings()).catalog.tables[0].columns.map { it.name }
        assertTrue(named.contains("column_number_700"))
    }

    @Test
    fun `trimming says how many columns are not shown`() {
        val pruned = CatalogPruner.pruneCatalog(wide(), "count rows", settings())
        assertTrue(pruned.catalog.tables[0].comment!!.contains("of 800 columns not shown"))
        assertTrue(pruned.schemaText.contains("columns not shown"))
    }

    @Test
    fun `a normal table is left alone`() {
        val pruned = CatalogPruner.pruneCatalog(catalog(listOf(table(0, columns = 10))), "count rows", settings())
        assertTrue(pruned.catalog.tables[0].columns.size == 10)
        assertTrue(pruned.catalog.tables[0].comment == null)
    }
}
