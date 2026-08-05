package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.Dialects
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PostgreSQL with `standard_conforming_strings=on` (its default since 9.1) does NOT treat `\'` as
 * an escaped quote in a plain literal: the string ends at the second quote and whatever follows is
 * live SQL. A lexer that swallows `\'` hides the statement separator that follows it.
 */
class BackslashEscapeTest {

    private val SMUGGLED =
        """SELECT 'a\'; SET default_transaction_read_only = off; DROP TABLE t; --'"""

    @Test
    fun `a backslash does not hide a statement separator from the lexer`() {
        val stripped = SqlLexer.stripCommentsAndStrings(SMUGGLED)
        assertTrue(
            "the lexer swallowed the smuggled statements: $stripped",
            stripped.contains(";"),
        )
    }

    @Test
    fun `the guard blocks a statement smuggled past a backslash`() {
        val verdict = SqlGuard.guard(SMUGGLED, Dialects.POSTGRES)
        assertFalse("guard allowed: ${verdict.pipelineDebug()}", verdict.allowed)
    }

    /** A doubled quote is the standard escape and must still be one literal. */
    @Test
    fun `a doubled quote is still a single literal`() {
        val stripped = SqlLexer.stripCommentsAndStrings("""SELECT 'it''s fine' FROM t""")
        assertFalse("doubled quote split the literal: $stripped", stripped.contains("fine"))
    }

    private fun com.rahulmahadik.asksql.ide.model.GuardVerdict.pipelineDebug() =
        "allowed=$allowed ruleId=$ruleId"
}
