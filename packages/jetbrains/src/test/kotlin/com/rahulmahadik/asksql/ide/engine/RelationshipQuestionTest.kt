package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/core/test/relationship-routing.test.ts. */
class RelationshipQuestionTest {

    @Test
    fun `routes a question about the link itself to prose`() {
        // The schema already states the foreign key; a join query returns rows instead of the answer.
        val prose = listOf(
            "how do customers and rentals relate?",
            "How are film and actor connected",
            "how does inventory link to store",
            "what is the relationship between customer and payment",
            "what's the link between rental and payment",
            "how are these tables associated",
            "and how do staff and store relate",
        )
        for (q in prose) assertTrue(q, EnginePipeline.isRelationshipQuestion(q))
    }

    @Test
    fun `leaves a question that filters by a relationship as a data question`() {
        val data = listOf(
            "show me customers related to store 1",
            "which films are linked to actor 5",
            "how many customers relate to each store",
            "list the related titles",
            "count the rentals connected to store 2",
        )
        for (q in data) assertFalse(q, EnginePipeline.isRelationshipQuestion(q))
    }

    @Test
    fun `leaves first-person questions alone`() {
        // The reader relating something, not two tables.
        for (q in listOf("how do I relate this to revenue growth", "how do i connect to the database", "how do I link my account")) {
            assertFalse(q, EnginePipeline.isRelationshipQuestion(q))
        }
    }
}
