package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** [ConnectionRegistry.withConnection] allows multiple concurrent leases on the same [java.sql.Connection], but JDBC doesn't guarantee thread-safe concurrent statement execution; checks whether that actually corrupts results. */
class ConcurrentQueryExecutionTest {

    @Test
    fun `many concurrent queries against the same SQLite connection each get their own correct result`() = runTest {
        val dbFile = File.createTempFile("asksql-concurrency-test", ".sqlite")
        dbFile.deleteOnExit()
        org.sqlite.JDBC().connect("jdbc:sqlite:${dbFile.path}", java.util.Properties())!!.use { seed ->
            seed.createStatement().use { st ->
                st.execute("CREATE TABLE numbers (n INTEGER PRIMARY KEY)")
                for (i in 1..20) st.execute("INSERT INTO numbers VALUES ($i)")
            }
        }

        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val descriptor = ConnectionDescriptor(
            id = "concurrency-test", name = "concurrency-test", engine = EngineKind.SQLITE,
            scope = ConnectionScope.PROJECT, filePath = dbFile.path,
        )

        // 20 concurrent queries, each filtering for a DIFFERENT single value: if the connection is
        // misused concurrently, at least one should come back wrong (count, empty, or exception).
        val results = (1..20).map { n ->
            async {
                try {
                    registry.withConnection(descriptor, null) { connection ->
                        val result = JdbcExecutor.execute(connection, "SELECT COUNT(*) AS c FROM numbers WHERE n = $n", maxRows = 10, timeoutMs = 5000, EngineKind.SQLITE)
                        n to (result.rows.firstOrNull()?.firstOrNull() as? com.rahulmahadik.asksql.ide.model.CellValue.Number)?.value
                    }
                } catch (e: Exception) {
                    n to null
                }
            }
        }.awaitAll()

        dbFile.delete()

        val failures = results.filter { (_, count) -> count != 1.0 }
        assertEquals("expected every concurrent query to correctly count exactly 1 matching row; failures: $failures", emptyList<Any>(), failures)
    }
}
