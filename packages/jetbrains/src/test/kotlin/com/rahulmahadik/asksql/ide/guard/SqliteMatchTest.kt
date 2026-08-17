package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A Room @Fts4 entity is queried with MATCH, which JSqlParser's grammar has no notion of, so every
 * full-text query was refused. Verified against a populated FTS4 table: MATCH returns the matching
 * rows and the `= 'term'` form returns none. Mirrors sqlite-match.test.ts.
 */
class SqliteMatchTest {

    private fun guard(sql: String) = SqlGuard.guard(sql, Dialects.of(EngineKind.SQLITE))

    @Test fun `a full-text query is allowed and keeps its operator`() {
        for (sql in listOf(
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'memory'",
            "SELECT body FROM messages_fts WHERE body MATCH 'memory'",
            "SELECT m.body FROM messages m JOIN messages_fts f ON f.rowid = m.id WHERE f.body MATCH 'rope memory'",
        )) {
            val v = guard(sql)
            assertTrue("$sql -> ${v.reason}", v.allowed)
            // Rewritten to `=` it would silently return nothing on FTS4, so the operator must survive.
            assertTrue("$sql -> ${v.sql}", v.sql.contains("MATCH", ignoreCase = true))
        }
    }

    @Test fun `the search term is kept exactly`() {
        assertTrue(guard("SELECT rowid FROM t_fts WHERE t_fts MATCH 'rope memory'").sql.contains("MATCH 'rope memory'"))
    }

    @Test fun `nothing else slips in behind it`() {
        for (sql in listOf(
            "DELETE FROM messages WHERE body MATCH 'x'",
            "UPDATE messages SET body = 'x' WHERE body MATCH 'y'",
            "SELECT 1 FROM t WHERE a MATCH 'x'; DROP TABLE t",
            "SELECT load_extension('x') FROM t WHERE a MATCH 'y'",
            "SELECT * FROM t WHERE a MATCH b",
            "SELECT * FROM t WHERE a MATCH (SELECT x FROM y)",
        )) {
            assertFalse(sql, guard(sql).allowed)
        }
    }

    @Test fun `the word inside a string literal is left alone`() {
        val v = guard("SELECT * FROM t WHERE note = 'a match here'")
        assertTrue(v.allowed)
        assertTrue(v.sql.contains("'a match here'"))
    }

    @Test fun `an engine without the operator still refuses it`() {
        assertFalse(SqlGuard.guard("SELECT * FROM t WHERE a MATCH 'x'", Dialects.of(EngineKind.POSTGRES)).allowed)
    }
}
