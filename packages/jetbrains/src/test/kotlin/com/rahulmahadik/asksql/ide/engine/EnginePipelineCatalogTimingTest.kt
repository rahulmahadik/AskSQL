package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.experimental.categories.Category
import java.net.Socket
import kotlin.time.Duration.Companion.seconds

/**
 * Times [EnginePipeline.catalog] against the same real local MySQL the other live tests use, isolating
 * whether a long-hanging schema load lives in introspection or in the tool-window code calling it.
 */
@Category(IntegrationTest::class)
class EnginePipelineCatalogTimingTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 53306
        private const val DB = "asksql_demo"
        private const val USER = "root"
    }

    @Test
    fun `catalog() against real local MySQL completes in well under the schema-tree's patience`() = runTest(timeout = 40.seconds) {
        val reachable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping", reachable)

        val descriptor = ConnectionDescriptor(
            id = "mysql-catalog-timing", name = "catalog-timing", engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
            host = HOST, port = PORT, database = DB, user = USER,
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)

        val startNanos = System.nanoTime()
        val catalog = pipeline.catalog(descriptor, password = null)
        val elapsedMs = (System.nanoTime() - startNanos) / 1_000_000
        println("EnginePipeline.catalog() took ${elapsedMs}ms, found ${catalog.tables.size} tables")

        assertTrue("expected at least one table back", catalog.tables.isNotEmpty())
        assertTrue("expected catalog() to complete in under 10s against a reachable local MySQL, took ${elapsedMs}ms", elapsedMs < 10_000)
    }

    /**
     * Proves catalog loads for independent connections don't block each other: the real local
     * MySQL connection runs concurrently with one pointed at a non-routable TEST-NET address
     * (192.0.2.1), and the fast one must finish well before the slow one resolves.
     */
    @Test
    fun `a fast connection's catalog resolves without waiting on a slow, unreachable one`() = runTest(timeout = 40.seconds) {
        val reachable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping", reachable)

        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val fastDescriptor = ConnectionDescriptor(
            id = "mysql-concurrency-fast", name = "fast", engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
            host = HOST, port = PORT, database = DB, user = USER,
        )
        val slowDescriptor = ConnectionDescriptor(
            id = "mysql-concurrency-slow", name = "slow", engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
            host = "192.0.2.1", port = 3306, database = DB, user = USER,
        )

        val startNanos = System.nanoTime()
        var fastCompletedAtMs = -1L
        var slowCompletedAtMs = -1L
        val slowJob = async {
            runCatching { pipeline.catalog(slowDescriptor, password = null) }
            slowCompletedAtMs = (System.nanoTime() - startNanos) / 1_000_000
        }
        val fastJob = async {
            pipeline.catalog(fastDescriptor, password = null)
            fastCompletedAtMs = (System.nanoTime() - startNanos) / 1_000_000
        }
        fastJob.await()
        println("fast connection resolved at ${fastCompletedAtMs}ms (slow connection still pending)")
        assertTrue("expected the fast connection to resolve in under 5s regardless of the slow one, took ${fastCompletedAtMs}ms", fastCompletedAtMs < 5_000)

        slowJob.await()
        println("slow (unreachable) connection resolved at ${slowCompletedAtMs}ms")
        assertTrue(
            "expected the fast connection to resolve well before the slow/unreachable one - got fast=${fastCompletedAtMs}ms, slow=${slowCompletedAtMs}ms",
            fastCompletedAtMs < slowCompletedAtMs,
        )
    }
}
