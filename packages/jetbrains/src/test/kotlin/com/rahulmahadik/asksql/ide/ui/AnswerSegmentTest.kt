package com.rahulmahadik.asksql.ide.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A query inside a prose answer must become a real code block, not flatten into the sentence around it. */
class AnswerSegmentTest {

    private fun prose(vararg segments: AnswerSegment) = segments.filterIsInstance<AnswerSegment.Prose>().map { it.text.trim() }
    private fun code(vararg segments: AnswerSegment) = segments.filterIsInstance<AnswerSegment.Code>()

    @Test fun `an answer with no fence is a single prose run`() {
        val out = splitFencedSegments("The orders table has 12 columns.")
        assertEquals(1, out.size)
        assertTrue(out.single() is AnswerSegment.Prose)
    }

    @Test fun `a fence is split out of the surrounding prose`() {
        val out = splitFencedSegments("Try this:\n```sql\nSELECT 1\n```\nThat counts the rows.")

        assertEquals(3, out.size)
        assertEquals(listOf("Try this:", "That counts the rows."), prose(*out.toTypedArray()))
        assertEquals("SELECT 1", code(*out.toTypedArray()).single().code)
        assertEquals("sql", code(*out.toTypedArray()).single().tag)
    }

    @Test fun `two fences both become code`() {
        val out = splitFencedSegments("First:\n```sql\nSELECT 1\n```\nThen:\n```sql\nSELECT 2\n```")

        assertEquals(listOf("SELECT 1", "SELECT 2"), code(*out.toTypedArray()).map { it.code })
    }

    @Test fun `a fence with no language tag still becomes code`() {
        val out = splitFencedSegments("```\nSELECT 1\n```")
        assertEquals("SELECT 1", code(*out.toTypedArray()).single().code)
        assertEquals("", code(*out.toTypedArray()).single().tag)
    }

    /** A half-streamed answer must not lose its text to an opening fence that never closes. */
    @Test fun `an unterminated fence stays prose`() {
        val out = splitFencedSegments("Here you go:\n```sql\nSELECT 1")

        assertEquals(1, out.size)
        assertTrue(out.single() is AnswerSegment.Prose)
        assertTrue((out.single() as AnswerSegment.Prose).text.contains("SELECT 1"))
    }

    @Test fun `a fence holding only whitespace is dropped`() {
        assertTrue(code(*splitFencedSegments("text\n```sql\n\n```").toTypedArray()).isEmpty())
    }

    @Test fun `a multi line body keeps its line breaks`() {
        val out = splitFencedSegments("```sql\nSELECT a,\n       b\nFROM t\n```")
        assertEquals("SELECT a,\n       b\nFROM t", code(*out.toTypedArray()).single().code)
    }

    /** Models emit a four-backtick fence when quoting fenced content. */
    @Test fun `a four backtick fence is one clean block`() {
        val out = splitFencedSegments("````\nSELECT 1\n````")

        assertEquals(1, out.size)
        assertEquals("SELECT 1", code(*out.toTypedArray()).single().code)
    }

    @Test fun `a four backtick fence carries no stray backtick into the code`() {
        val block = code(*splitFencedSegments("text\n````sql\nSELECT 1\n````").toTypedArray()).single()
        assertFalse("stray backtick in ${block.code}", block.code.contains("`"))
    }

    @Test fun `sql dialect tags map to the sql file type`() {
        for (tag in listOf("sql", "postgres", "postgresql", "psql", "mysql", "mariadb", "sqlite", "tsql", "plsql", "oracle")) {
            assertEquals("tag $tag", "sql" to "SQL", fenceLanguage(tag, defaultIsJson = false))
        }
    }

    @Test fun `json maps to json, and an untagged mongo answer defaults to json`() {
        assertEquals("json" to "JSON", fenceLanguage("json", defaultIsJson = false))
        assertEquals("json" to "JSON", fenceLanguage("", defaultIsJson = true))
        assertEquals("sql" to "SQL", fenceLanguage("", defaultIsJson = false))
    }

    /** An unknown tag must not be highlighted as SQL. */
    @Test fun `an unknown tag falls back to plain text`() {
        assertEquals("txt" to "TEXT", fenceLanguage("python", defaultIsJson = false))
        assertEquals("txt" to "TEXT", fenceLanguage("bash", defaultIsJson = true))
    }
}
