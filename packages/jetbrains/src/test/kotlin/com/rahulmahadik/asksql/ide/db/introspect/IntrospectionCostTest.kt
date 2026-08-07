package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.test.IntegrationTest
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.experimental.categories.Category
import java.sql.DriverManager

/**
 * Introspection cost on a wide schema. Needs a `perf` schema of 300 tables in the local
 * `asksql_test` database; build it with `node tools/perf-schema.mjs`. A missing schema fails rather
 * than skips, so the measurement cannot quietly stop happening.
 */
@Category(IntegrationTest::class)
class IntrospectionCostTest {

    private fun connect() =
        runCatching { DriverManager.getConnection("jdbc:postgresql://localhost:5432/asksql_test", "postgres", "root") }
            .getOrNull()

    @Test
    fun `introspecting a 300-table schema stays within a sane round-trip budget`() {
        val connection = connect() ?: run {
            println("[skip] introspection cost - no local Postgres on 5432")
            return
        }
        connection.use { c ->
            // Warm the connection so the first query's setup cost lands on neither side.
            CommonIntrospection.listTables(c, catalog = null, schemaPattern = "perf", loadConstraints = false)

            val perTableStart = System.currentTimeMillis()
            val perTable = CommonIntrospection.listTables(c, catalog = null, schemaPattern = "perf", loadConstraints = true)
            val perTableMs = System.currentTimeMillis() - perTableStart

            val batchedStart = System.currentTimeMillis()
            val tables = CommonIntrospection.listTables(c, catalog = null, schemaPattern = "perf", loadConstraints = false)
            PostgresConstraints.load(c)
            val batchedMs = System.currentTimeMillis() - batchedStart

            println("[introspect] ${tables.size} tables: per-table ${perTableMs}ms vs batched ${batchedMs}ms")
            assertTrue(
                "expected the perf schema; found ${perTable.size} tables. Build it with `node tools/perf-schema.mjs`.",
                perTable.size >= 300,
            )
            assertTrue("batched (${batchedMs}ms) should not be slower than per-table (${perTableMs}ms)", batchedMs <= perTableMs)
        }
    }
}
