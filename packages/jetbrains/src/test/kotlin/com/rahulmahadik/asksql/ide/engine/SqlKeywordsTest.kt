package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/core/test/sql-keywords.test.ts; both are generated from the same source. */
class SqlKeywordsTest {

    @Test fun `gives each engine its own list`() {
        assertTrue(SqlKeywords.reservedWordsFor("mysql").size > SqlKeywords.reservedWordsFor("postgres").size)
    }

    @Test fun `every engine reserves select`() {
        for (engine in listOf("postgres", "mysql", "oracle", "sqlite", "duckdb")) {
            assertTrue(engine, SqlKeywords.reservedWordsFor(engine).contains("select"))
        }
    }

    /** MySQL reserves it, Postgres does not: proof the lists are not one shared set. */
    @Test fun `separates a word that only some engines reserve`() {
        assertTrue(SqlKeywords.reservedWordsFor("mysql").contains("rank"))
        assertFalse(SqlKeywords.reservedWordsFor("postgres").contains("rank"))
    }

    /** An unknown engine gets the union, so a name is over-quoted rather than left broken. */
    @Test fun `falls back to the union for an unknown engine`() {
        assertTrue(SqlKeywords.reservedWordsFor("not-an-engine").size > SqlKeywords.reservedWordsFor("mysql").size)
    }

    @Test fun `matches the core list sizes`() {
        assertEquals(101, SqlKeywords.reservedWordsFor("postgres").size)
        assertEquals(262, SqlKeywords.reservedWordsFor("mysql").size)
    }
}
