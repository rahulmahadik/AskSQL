package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.GuardPolicy
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Properties

/**
 * A result that exactly fills the row cap is truncated, and must say so. The reader cannot tell the
 * difference between "1000 rows" and "the first 1000 of 16000" from the grid alone, and an export of
 * the same result would be silently partial. Mirrors packages/core/test/limits.test.ts.
 */
class RowCapTruncationTest {

    private val policy = GuardPolicy(maxRows = 10)

    private fun seed(rows: Int): ConnectionDescriptor {
        val file = File.createTempFile("asksql-rowcap", ".sqlite")
        file.deleteOnExit()
        org.sqlite.JDBC().connect("jdbc:sqlite:${file.path}", Properties())!!.use { c ->
            c.createStatement().use { st ->
                st.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")
                st.execute("INSERT INTO t SELECT value FROM (WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < $rows) SELECT value FROM n)")
            }
        }
        return ConnectionDescriptor(
            id = "rowcap", name = "rowcap", engine = EngineKind.SQLITE,
            scope = ConnectionScope.PROJECT, filePath = file.path,
        )
    }

    private fun pipeline() =
        EnginePipeline(ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))
            .also { it.policy = policy }

    @Test
    fun `a lowered limit that fills the cap is reported as truncated`() = runTest {
        // The model wrote its own LIMIT above the ceiling, so the guard LOWERS it rather than adding
        // one: autoLimited stays false and only loweredLimit is set.
        val result = pipeline().execute("SELECT * FROM t LIMIT 5000", seed(50), null)
        assertEquals(10, result.rowCount)
        assertTrue("expected truncated=true", result.truncated)
        assertTrue(result.warnings.joinToString(" "), result.warnings.any { it.contains("lowered", ignoreCase = true) })
    }

    @Test
    fun `an injected limit that fills the cap is reported as truncated`() = runTest {
        val result = pipeline().execute("SELECT * FROM t", seed(50), null)
        assertEquals(10, result.rowCount)
        assertTrue("expected truncated=true", result.truncated)
    }

    @Test
    fun `a result under the cap is not reported as truncated`() = runTest {
        val result = pipeline().execute("SELECT * FROM t", seed(3), null)
        assertEquals(3, result.rowCount)
        assertTrue("expected truncated=false", !result.truncated)
    }

    /**
     * Approving generated SQL re-guards text that already carries the injected LIMIT, so the fresh
     * verdict reports no cap. Without the ask-time verdict the cap becomes invisible at exactly the
     * moment the user is shown the rows.
     */
    @Test
    fun `the ask-time verdict survives re-guarding on approval`() = runTest {
        val descriptor = seed(50)
        val pipeline = pipeline()
        val alreadyCapped = "SELECT * FROM t\nLIMIT 10"

        val withoutPrior = pipeline.execute(alreadyCapped, descriptor, null)
        assertTrue("a bare re-guard cannot see the cap", !withoutPrior.truncated)

        val askTime = com.rahulmahadik.asksql.ide.guard.SqlGuard.guard("SELECT * FROM t", com.rahulmahadik.asksql.ide.model.Dialects.of(EngineKind.SQLITE), policy)
        assertTrue("the ask-time guard should have capped this", askTime.autoLimited)
        val withPrior = pipeline.execute(alreadyCapped, descriptor, null, priorVerdict = askTime)
        assertTrue("expected truncated=true once the ask-time verdict is carried", withPrior.truncated)
        assertTrue(withPrior.warnings.joinToString(" "), withPrior.warnings.any { it.contains("row limit", ignoreCase = true) })
    }
}
