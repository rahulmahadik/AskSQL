package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.test.IntegrationTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.experimental.categories.Category
import java.sql.DriverManager

/**
 * The batched catalog queries must agree with the per-table JDBC calls they replace, table for
 * table. Faster is worthless if the metadata quietly changes.
 */
@Category(IntegrationTest::class)
class PostgresConstraintsParityTest {

    private fun connect() =
        runCatching { DriverManager.getConnection("jdbc:postgresql://localhost:5432/asksql_test", "postgres", "root") }
            .getOrNull()

    @Test
    fun `batched keys and indexes match the per-table calls exactly`() {
        val connection = connect() ?: run {
            println("[skip] constraints parity - no local Postgres on 5432")
            return
        }
        connection.use { c ->
            val perTable = CommonIntrospection.listTables(c, catalog = null, schemaPattern = null, loadConstraints = true)
                .filterNot { it.schema in setOf("pg_catalog", "information_schema") }
            assertTrue("expected some tables to compare", perTable.isNotEmpty())

            val batched = PostgresConstraints.load(c)
            assertTrue("batched load returned null", batched != null)

            var compared = 0
            for (t in perTable) {
                val key = t.schema to t.name
                assertEquals("primary key for ${t.schema}.${t.name}", t.primaryKey, batched!!.primaryKeys[key].orEmpty())

                val expectedFks = t.foreignKeys.map { it.columns to (it.refTable to it.refColumns) }.toSet()
                val actualFks = batched.foreignKeys[key].orEmpty().map { it.columns to (it.refTable to it.refColumns) }.toSet()
                assertEquals("foreign keys for ${t.schema}.${t.name}", expectedFks, actualFks)

                val expectedIdx = t.indexes.map { it.name to (it.unique to it.columns) }.toSet()
                val actualIdx = batched.indexes[key].orEmpty().map { it.name to (it.unique to it.columns) }.toSet()
                assertEquals("indexes for ${t.schema}.${t.name}", expectedIdx, actualIdx)
                compared++
            }
            println("[parity] compared $compared tables")
        }
    }
}
