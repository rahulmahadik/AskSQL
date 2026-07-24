package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ported directly from core's `test/unit.test.ts` `describe('extractSql')` block; the real-world cases [Extract] must handle as a faithful port of core. */
class ExtractTest {

    @Test
    fun `fenced sql block`() {
        val r = Extract.extractSql("Here you go:\n```sql\nSELECT 1\n```\nThat returns one.")
        assertEquals("SELECT 1", r?.sql)
        assertTrue(r?.explanation?.contains("returns one", ignoreCase = true) == true)
    }

    @Test
    fun `unlabeled fence`() {
        assertEquals("SELECT * FROM t", Extract.extractSql("```\nSELECT * FROM t\n```")?.sql)
    }

    @Test
    fun `whole message is SQL`() {
        assertEquals(Extract.ExtractionSource.WHOLE, Extract.extractSql("SELECT count(*) FROM users")?.source)
    }

    @Test
    fun `inline SELECT among prose`() {
        val r = Extract.extractSql("The query is:\nSELECT a FROM b\n\nEnjoy.")
        assertTrue(r?.sql?.contains("SELECT a FROM b") == true)
    }

    @Test
    fun `picks the query fence, not a result fence`() {
        val r = Extract.extractSql("Result:\n```\nid | name\n```\nQuery:\n```sql\nSELECT id,name FROM t\n```")
        assertEquals("SELECT id,name FROM t", r?.sql)
    }

    @Test
    fun `no sql means null`() {
        assertNull(Extract.extractSql("I can't help with that."))
    }

    @Test
    fun `IMPOSSIBLE sentinel`() {
        assertTrue(Extract.extractImpossible("IMPOSSIBLE: there is no revenue column")?.contains("revenue") == true)
        assertNull(Extract.extractImpossible("SELECT 1"))
    }

    @Test
    fun `IMPOSSIBLE must be at the start, not just mentioned anywhere in the response`() {
        // A model explaining why something is impossible mid-sentence must not
        // be misread as the sentinel; only a response that STARTS with it counts.
        assertNull(Extract.extractImpossible("It would be IMPOSSIBLE: to do that without more context, but here is SELECT 1"))
    }

    @Test
    fun `IMPOSSIBLE sentinel is case-sensitive, matching core exactly`() {
        // The model is prompted to emit this sentinel verbatim in uppercase;
        // lowercase "impossible:" at the start of a response is just prose.
        assertNull(Extract.extractImpossible("impossible: this is a made-up sentence, not the sentinel"))
    }

    @Test
    fun `IMPOSSIBLE reason stops at the first line when a noncompliant model rambles for paragraphs`() {
        val rambling = "IMPOSSIBLE: Client ID is NOT NULL in the clients table, so I cannot fetch client data\n" +
            "To provide row-level answers, I need to query all related tables\n" +
            "Solution: To query related tables, you need to join other tables\n" +
            "```sql\nToo see related information```sql"
        val reason = Extract.extractImpossible(rambling)
        assertEquals("Client ID is NOT NULL in the clients table, so I cannot fetch client data", reason)
    }

    @Test
    fun `an overlong single-line reason is truncated at a word boundary with an ellipsis`() {
        val longReason = "IMPOSSIBLE: " + "word ".repeat(100).trim()
        val reason = Extract.extractImpossible(longReason)!!
        assertTrue(reason.length <= 301)
        assertTrue(reason.endsWith("…"))
        assertTrue(!reason.endsWith(" …"))
    }

    @Test
    fun `the internal sentinel word never survives into the user-facing reason`() {
        val repeated = "IMPOSSIBLE: IMPOSSIBLE: there is no revenue column in this schema"
        val reason = Extract.extractImpossible(repeated)!!
        assertTrue("sentinel leaked: $reason", !reason.contains("IMPOSSIBLE", ignoreCase = true))
        assertTrue(reason.contains("revenue column"))
    }

    // The inputs below are verbatim model output captured from a live run against real databases.

    @Test
    fun `an off-topic refusal collapses to one plain sentence`() {
        val a = Extract.extractImpossible(
            "IMPOSSIBLE: The question cannot be answered as it is not related to the schema provided and does not request any data from the tables available.",
        )
        val b = Extract.extractImpossible(
            "IMPOSSIBLE: The question is not related to the provided schema and does not query any data from the collections.",
        )
        assertEquals("That question isn't about the data in this database.", a)
        assertEquals("That question isn't about the data in this database.", b)
    }

    @Test
    fun `stiff schema phrasing is rewritten to plain English, keeping the specifics`() {
        val reason = Extract.extractImpossible(
            "IMPOSSIBLE: The schema does not contain any information about countries or their capitals.",
        )!!
        assertEquals("This database doesn't have anything about countries or their capitals.", reason)
    }

    @Test
    fun `a reason with real detail keeps that detail`() {
        val reason = Extract.extractImpossible(
            "IMPOSSIBLE: The provided schema does not contain a revenue column on the orders table.",
        )!!
        assertTrue(reason.contains("revenue column"))
        assertTrue(reason.contains("this database", ignoreCase = true))
        assertTrue("model-speak survived: $reason", !reason.contains("does not contain"))
    }

    @Test
    fun `looksLikeRefusal detects common refusal phrasing`() {
        assertTrue(Extract.looksLikeRefusal("I'm sorry, I cannot help with that."))
        assertTrue(!Extract.looksLikeRefusal("SELECT * FROM customers"))
    }

    // ---- Fence language tags other than "sql" ----

    @Test
    fun `a fenced block tagged with the engine dialect name extracts clean SQL`() {
        val extraction = Extract.extractSql("```postgresql\nSELECT id FROM t\n```")
        assertEquals("SELECT id FROM t", extraction?.sql)
    }

    @Test
    fun `a fenced block tagged with mixed-case Sql extracts clean SQL`() {
        val extraction = Extract.extractSql("```Sql\nSELECT id FROM t\n```")
        assertEquals("SELECT id FROM t", extraction?.sql)
    }

    @Test
    fun `a fenced block tagged sqlite extracts clean SQL, not a truncated tag remainder`() {
        val extraction = Extract.extractSql("```sqlite\nSELECT id FROM t\n```")
        assertEquals("SELECT id FROM t", extraction?.sql)
    }

    @Test
    fun `a fenced block tagged mysql extracts clean SQL`() {
        val extraction = Extract.extractSql("```mysql\nSELECT id FROM t\n```")
        assertEquals("SELECT id FROM t", extraction?.sql)
    }

    // ---- A model that never closes its fence before writing prose, and/or hedges with "IMPOSSIBLE:" while still producing usable SQL ----

    @Test
    fun `a fence with an unclosed Explanation comment before the real closing fence is trimmed to just the query`() {
        val extraction = Extract.extractSql(
            "```sql\nSELECT id, name FROM products\n\n-- Explanation:\nThis picks id and name.\n```",
        )
        assertEquals("SELECT id, name FROM products", extraction?.sql)
    }

    @Test
    fun `a response starting with IMPOSSIBLE but still containing usable SQL extracts the SQL, not the raw blob`() {
        val text = "IMPOSSIBLE: the question asks for something not in the schema. Here is a related query:\n" +
            "```sql\nSELECT id, name, category, price_cents FROM products\n```\n" +
            "If you meant something else, please clarify."
        val extraction = Extract.extractSql(text)
        assertEquals("SELECT id, name, category, price_cents FROM products", extraction?.sql)
    }
}
