package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The settings field is free text, so anything that is not `term = definition` is skipped rather than sent. */
class GlossaryParseTest {

    @Test
    fun `reads one term per line`() {
        val parsed = EnginePipeline.parseGlossary(
            "big order = an order whose total_cents is over 100000\nrevenue in dollars = sum of total_cents / 100",
        )
        assertEquals(2, parsed.size)
        assertEquals("big order", parsed[0].term)
        assertEquals("an order whose total_cents is over 100000", parsed[0].definition)
    }

    @Test
    fun `skips blank lines, prose and half-written entries`() {
        val parsed = EnginePipeline.parseGlossary("\n\njust some prose\n= no term\nterm with no definition =\n  \n")
        assertTrue(parsed.toString(), parsed.isEmpty())
    }

    @Test
    fun `keeps an equals sign inside the definition`() {
        val parsed = EnginePipeline.parseGlossary("paid = status = 'paid'")
        assertEquals(1, parsed.size)
        assertEquals("status = 'paid'", parsed[0].definition)
    }

    @Test
    fun `caps how much can be sent`() {
        val many = (1..60).joinToString("\n") { "term$it = definition $it" }
        assertEquals(40, EnginePipeline.parseGlossary(many).size)
    }
}
