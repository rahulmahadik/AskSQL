package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the core predicate: asking to run a query already shown is not a new question. */
class RerunPreviousTest {

    @Test
    fun `a request to run the query already shown is recognised`() {
        for (q in listOf(
            "can you run this query and show me data",
            "run that query",
            "show me that query results",
            "execute the previous query",
            "please re-run the last query",
        )) {
            assertTrue(q, EnginePipeline.isRerunPreviousRequest(q))
        }
    }

    @Test
    fun `an ordinary question is not`() {
        for (q in listOf(
            "show me all orders",
            "run a report of revenue by region",
            "how many customers are there",
            "show me the tables",
            "give me the top 10 customers by spend",
        )) {
            assertFalse(q, EnginePipeline.isRerunPreviousRequest(q))
        }
    }
}
