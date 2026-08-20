package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A reasoning model narrates before it answers. Reported from a real install on Groq's qwen3.6: the whole
 * "<think> The user wants to show me users. Looking at the schema..." monologue was shown to the reader as
 * the query's description. Mirrors the TypeScript half in packages/core/test/.
 */
class ReasoningStripTest {

    @Test fun `a closed reasoning block never reaches the reader`() {
        val reply = "<think>\nThe user wants a count. The clients table is right.\n</think>\n" +
            "```sql\nSELECT COUNT(*) FROM clients\n```\nCounts the clients."
        val extracted = Extract.extractSql(reply)!!
        assertEquals("SELECT COUNT(*) FROM clients", extracted.sql)
        assertEquals("Counts the clients.", extracted.explanation)
        assertFalse(extracted.explanation.contains("<think>"))
        assertFalse(extracted.explanation.contains("The user wants"))
    }

    @Test fun `an answer cut off mid-thought yields no query rather than narration`() {
        // The reply ran out of tokens while still reasoning, so there is no SQL in it at all.
        assertNull(Extract.extractSql("<think>\nThe user wants users. Looking at the schema, there is a clients"))
    }

    @Test fun `the thinking tag is matched whatever it is called`() {
        for (tag in listOf("think", "thinking", "reasoning")) {
            val out = Extract.withoutReasoning("<$tag>hidden</$tag> visible")
            assertEquals(tag, "visible", out)
        }
    }

    @Test fun `a reply with no reasoning is untouched`() {
        val extracted = Extract.extractSql("```sql\nSELECT 1\n```\nPlain answer.")!!
        assertEquals("SELECT 1", extracted.sql)
        assertEquals("Plain answer.", extracted.explanation)
    }

    @Test fun `an IMPOSSIBLE verdict is read past the narration`() {
        val reason = Extract.extractImpossible("<think>\nNo such table anywhere.\n</think>\nIMPOSSIBLE: there is no orders table")
        assertTrue(reason ?: "", (reason ?: "").contains("no orders table"))
    }
}
