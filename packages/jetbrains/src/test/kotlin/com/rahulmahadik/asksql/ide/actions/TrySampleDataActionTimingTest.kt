package com.rahulmahadik.asksql.ide.actions

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.engine.EnginePipeline
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import kotlin.time.Duration.Companion.seconds

/**
 * Times the full "Try with sample data" flow: seed the SQLite file via
 * [TrySampleDataAction.materializeSampleDatabase], then load its schema via [EnginePipeline.catalog].
 */
class TrySampleDataActionTimingTest {

    @Test
    fun `materializeSampleDatabase completes quickly and produces a queryable catalog`() = runTest(timeout = 30.seconds) {
        val seedStart = System.nanoTime()
        val path = TrySampleDataAction.materializeSampleDatabase()
        val seedElapsedMs = (System.nanoTime() - seedStart) / 1_000_000
        println("materializeSampleDatabase() took ${seedElapsedMs}ms")
        assertTrue("expected the sample db file to exist", Files.exists(path))
        assertTrue("expected seeding to complete in under 5s, took ${seedElapsedMs}ms", seedElapsedMs < 5_000)

        val descriptor = ConnectionDescriptor(
            id = "asksql-sample-shop-timing", name = "sample-timing", engine = EngineKind.SQLITE,
            scope = ConnectionScope.PROJECT, filePath = path.toString(), isSample = true,
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)

        val catalogStart = System.nanoTime()
        val catalog = pipeline.catalog(descriptor, password = null)
        val catalogElapsedMs = (System.nanoTime() - catalogStart) / 1_000_000
        println("catalog() over the sample db took ${catalogElapsedMs}ms")

        val tableNames = catalog.tables.map { it.name }.toSet()
        assertTrue("expected the 4 seeded tables, got $tableNames", tableNames.containsAll(listOf("customers", "products", "orders", "order_items")))
        assertTrue("expected catalog() over a local sqlite file to complete in under 5s, took ${catalogElapsedMs}ms", catalogElapsedMs < 5_000)
    }
}
