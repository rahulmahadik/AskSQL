package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The reported question, verbatim, and the spellings a user actually types. */
class AdviceTypoRoutingTest {

    private val asked = "to apply all best pracitices to our schema what are changes needed?"

    @Test fun `the question as typed is recognised as advice`() {
        assertTrue("routed to SQL instead of advice: $asked", EnginePipeline.isSchemaAdviceQuestion(asked))
    }

    @Test fun `the same question spelled correctly is recognised`() {
        val correct = "to apply all best practices to our schema what are changes needed?"
        assertTrue(correct, EnginePipeline.isSchemaAdviceQuestion(correct))
    }

    @Test fun `optimisation and improvement questions are advice, however they are phrased`() {
        val questions = listOf(
            "what optimizations can we make to this database?",
            "what optimisations should we apply?",
            "how can we improve this database?",
            "what improvements are needed here?",
            "any performance improvements you would suggest?",
            "what should we change to make this schema better?",
            "suggest improvements for this schema",
            "how would you optimise these tables?",
        )
        for (q in questions) {
            assertTrue("not routed to advice: $q", EnginePipeline.isSchemaAdviceQuestion(q))
        }
    }

    /** "changes" is also an ordinary data word; those questions must still reach the data. */
    @Test fun `a question about changes in the data is not advice`() {
        val dataQuestions = listOf(
            "what changes did the user make to their profile?",
            "show me all changes in the orders table",
            "which changes were recorded last week?",
        )
        for (q in dataQuestions) {
            assertFalse("a data question was routed to prose: $q", EnginePipeline.isSchemaAdviceQuestion(q))
        }
    }
}
