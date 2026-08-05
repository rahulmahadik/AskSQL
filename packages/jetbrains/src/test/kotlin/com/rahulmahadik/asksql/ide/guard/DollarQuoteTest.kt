package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.Dialects
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PostgreSQL dollar-quoted strings: an apostrophe inside `$$...$$` is data, not a quote. A lexer
 * that misses them opens a string that never closes and blanks the rest of the statement.
 */
class DollarQuoteTest {

    private val LOCKING = """SELECT ${'$'}${'$'}'${'$'}${'$'} AS q FROM t FOR UPDATE"""

    @Test
    fun `a dollar-quoted apostrophe does not blank the rest of the statement`() {
        val stripped = SqlLexer.stripCommentsAndStrings(LOCKING)
        assertTrue("lexer blanked the tail: $stripped", stripped.contains("FOR UPDATE", ignoreCase = true))
    }

    @Test
    fun `the locking clause is still caught behind a dollar quote`() {
        val v = SqlGuard.guard(LOCKING, Dialects.POSTGRES)
        assertFalse("guard allowed a locking clause: ruleId=${v.ruleId}", v.allowed)
    }

    @Test
    fun `a tagged dollar quote is handled too`() {
        val sql = """SELECT ${'$'}tag${'$'}it's fine${'$'}tag${'$'} AS q FROM t FOR UPDATE"""
        assertFalse(SqlGuard.guard(sql, Dialects.POSTGRES).allowed)
    }

    @Test
    fun `an ordinary select is untouched`() {
        assertTrue(SqlGuard.guard("SELECT id FROM t WHERE name = 'x'", Dialects.POSTGRES).allowed)
    }
}
