package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Oracle has no LIMIT; refusing it here lets the repair loop rewrite the query. */
class OracleLimitTest {

    private fun guard(sql: String) = SqlGuard.guard(sql, Dialects.of(EngineKind.ORACLE))

    @Test
    fun `a LIMIT clause is refused`() {
        for (sql in listOf(
            "SELECT * FROM emp LIMIT 100",
            "SELECT ename FROM emp ORDER BY ename LIMIT 10 OFFSET 5",
            "select * from emp limit 5",
        )) {
            val verdict = guard(sql)
            assertTrue(sql, !verdict.allowed)
            assertEquals(sql, "limit_unsupported", verdict.ruleId)
        }
    }

    @Test
    fun `the row limiting Oracle does support is untouched`() {
        assertTrue(guard("SELECT * FROM emp FETCH FIRST 10 ROWS ONLY").allowed)
        assertTrue(guard("SELECT * FROM emp ORDER BY empno").allowed)
        assertTrue(guard("SELECT * FROM emp WHERE note = 'limit 5'").allowed)
    }
}
