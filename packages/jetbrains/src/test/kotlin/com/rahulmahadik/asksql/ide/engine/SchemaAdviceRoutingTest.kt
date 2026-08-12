package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Reported: asking for schema advice returned the same catalog listing every time. */
class SchemaAdviceRoutingTest {

    private val adviceQuestions = listOf(
        "apply all best practices to our schema what are changes needed?",
        "apply all best practices to our schema, what changes are needed?",
        "what changes are needed to follow best practices?",
        "review my schema and tell me what to improve",
        "what indexes should I add?",
        "how can I normalise this schema?",
        "are there any redundant columns I should drop?",
        "what would you change about this database design?",
    )

    @Test fun `advice never routes to the catalog listing`() {
        for (q in adviceQuestions) {
            assertFalse("routed to a table listing: $q", EnginePipeline.isMetadataQuestion(q))
        }
    }

    /** The pipeline routes advice to the prose path only if this is true; otherwise the model writes SQL. */
    @Test fun `advice is recognised as advice`() {
        for (q in adviceQuestions) {
            assertTrue("not recognised as schema advice: $q", EnginePipeline.isSchemaAdviceQuestion(q))
        }
    }

    @Test fun `advice is not treated as a database overview`() {
        for (q in adviceQuestions) {
            assertFalse("routed to an overview: $q", EnginePipeline.isDatabaseOverviewQuestion(q))
        }
    }
}
