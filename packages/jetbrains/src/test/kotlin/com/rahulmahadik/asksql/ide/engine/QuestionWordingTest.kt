package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Wording variations, the same set core's probe uses. People do not phrase questions the way a
 * test author would, and a phrasing that misroutes returns a table listing instead of an answer.
 */
class QuestionWordingTest {

    private fun route(q: String): String = when {
        Scope.isPromptInjection(q) -> "decline"
        Scope.isCapabilityQuestion(q) -> "capability"
        EnginePipeline.isWriteRequest(q) -> "write"
        EnginePipeline.isSchemaAdviceQuestion(q) || EnginePipeline.isDatabaseOverviewQuestion(q) -> "prose"
        else -> "data"
    }

    @Test
    fun `advice and overview phrasings route to prose`() {
        for (q in listOf(
            "how can the schema be improved",
            "can you take a look at my schema",
            "i want to improve my db",
            "anything i should change in this schema",
            "give me feedback on the schema",
            "do I need an index here",
            "should there be an index on customer_id",
            "would an index help here",
            "how do I index this properly",
            "this is slow, what do I do",
            "the query takes forever",
            "performance is bad, ideas?",
            "my joins are slow",
            "should this be normalized",
            "do I have too many tables",
            "is my table design ok",
            "thoughts on this data model",
            "does this design make sense",
            "what does this query do",
            "break down this query for me",
            "rewrite this in postgres",
            "port this query to mysql",
            "why am I getting extra rows",
            "what is in this database",
            "brief me on this database",
            "what does this database contain",
        )) assertEquals(q, "prose", route(q))
    }

    @Test
    fun `write requests route to a proposal however they are worded`() {
        for (q in listOf(
            "write me a delete statement for cancelled orders",
            "i need sql to remove old rows",
            "can you generate an insert statement",
            "give me the ddl to add a column",
            "produce an update query for prices",
        )) assertEquals(q, "write", route(q))
    }

    @Test
    fun `ordinary data questions stay data`() {
        for (q in listOf(
            "how many orders",
            "orders count",
            "i want to see revenue by region",
            "which customer spent the most",
            "orders from last month",
            "list customers without orders",
            "average basket size",
            "are there any duplicate emails",
        )) assertEquals(q, "data", route(q))
    }
}
