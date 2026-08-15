package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Oracle has no LIMIT: a plain trailing count is translated, and every other form is refused. */
class OracleLimitTest {

    private fun guard(sql: String) = SqlGuard.guard(sql, Dialects.of(EngineKind.ORACLE))

    @Test
    fun `a plain trailing LIMIT becomes the clause Oracle has`() {
        for ((sql, expected) in listOf(
            "SELECT * FROM emp LIMIT 100" to "FETCH FIRST 100 ROWS ONLY",
            "select * from emp limit 5" to "FETCH FIRST 5 ROWS ONLY",
        )) {
            val verdict = guard(sql)
            assertTrue(sql, verdict.allowed)
            assertTrue("$sql -> ${verdict.sql}", verdict.sql.contains(expected))
        }
    }

    @Test
    fun `a LIMIT with an offset is still refused, having no single-clause equivalent`() {
        val verdict = guard("SELECT ename FROM emp ORDER BY ename LIMIT 10 OFFSET 5")
        assertTrue(!verdict.allowed)
        assertEquals("limit_unsupported", verdict.ruleId)
    }

    @Test
    fun `the row limiting Oracle does support is untouched`() {
        assertTrue(guard("SELECT * FROM emp FETCH FIRST 10 ROWS ONLY").allowed)
        assertTrue(guard("SELECT * FROM emp ORDER BY empno").allowed)
        assertTrue(guard("SELECT * FROM emp WHERE note = 'limit 5'").allowed)
    }
}
