package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.experimental.categories.Category
import java.net.Socket
import kotlin.time.Duration.Companion.seconds

/** Times [JdbcConnectionFactory.open] against the same real local MySQL the other live tests use, to isolate whether a slow connection lives in this function or in the surrounding dialog/progress UI. */
@Category(IntegrationTest::class)
class JdbcConnectionFactoryLiveTimingTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 53306
        private const val DB = "asksql_demo"
        private const val USER = "root"
    }

    @Test
    fun `open() against real local MySQL completes in well under the 30s UI timeout`() = runTest(timeout = 40.seconds) {
        val reachable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping", reachable)

        val descriptor = ConnectionDescriptor(
            id = "mysql-timing", name = "timing", engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
            host = HOST, port = PORT, database = DB, user = USER,
        )
        val startNanos = System.nanoTime()
        val connection = JdbcConnectionFactory.open(descriptor, password = null)
        val elapsedMs = (System.nanoTime() - startNanos) / 1_000_000
        connection.close()
        println("JdbcConnectionFactory.open() took ${elapsedMs}ms")
        assertTrue("expected open() to complete in under 5s against a reachable local MySQL, took ${elapsedMs}ms", elapsedMs < 5_000)
    }
}
