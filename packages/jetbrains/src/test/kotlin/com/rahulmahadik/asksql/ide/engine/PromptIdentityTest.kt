package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the core prompt test: a missing database name became 'your_database_name' in real queries. */
class PromptIdentityTest {

    @Test fun `names the database and schema so system-catalog filters are real`() {
        val text = Prompts.buildSqlUser(
            question = "what views exist?", schemaText = "TABLE film",
            database = "sakila", schemas = listOf("public"),
        )

        assertTrue(text, text.contains("\"sakila\""))
        assertTrue(text, text.contains("\"public\""))
        assertTrue(text, text.contains("never write a placeholder"))
    }

    @Test fun `says nothing when the connection does not report a database`() {
        val text = Prompts.buildSqlUser(question = "q", schemaText = "s")
        assertFalse(text, text.contains("You are connected to"))
    }

    /** System-catalog columns are not in the schema block, so the model used to guess them. */
    @Test fun `offers a correct catalog query for a structure question`() {
        val text = Prompts.buildSqlUser(
            question = "what tables exist?", schemaText = "TABLE film",
            catalogHint = "SELECT name FROM sqlite_master",
        )

        assertTrue(text, text.contains("SELECT name FROM sqlite_master"))
    }

    @Test fun `offers no catalog query for an ordinary data question`() {
        assertFalse(Prompts.buildSqlUser(question = "how many films?", schemaText = "s").contains("structure"))
    }
}
