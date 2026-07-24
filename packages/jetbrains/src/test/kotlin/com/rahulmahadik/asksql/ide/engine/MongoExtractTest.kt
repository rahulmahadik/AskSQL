package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MongoExtractTest {

    @Test fun `extracts a fenced pipeline call`() {
        val text = """
            Here is the query:
            ```js
            db.orders.aggregate([{"${'$'}match": {"status": "paid"}}])
            ```
            This finds paid orders.
        """.trimIndent()
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("orders", extraction.collection)
        assertEquals("""[{"${'$'}match": {"status": "paid"}}]""", extraction.pipelineJson)
        assertEquals(MongoExtract.ExtractionSource.FENCE, extraction.source)
        assertTrue(extraction.explanation.contains("paid orders"))
    }

    @Test fun `extracts an unfenced whole-message call`() {
        val text = """db.users.aggregate([{"${'$'}count": "n"}])"""
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("users", extraction.collection)
        assertEquals(MongoExtract.ExtractionSource.WHOLE, extraction.source)
    }

    @Test fun `handles a pipeline containing nested brackets and braces correctly`() {
        val text = """
            ```js
            db.orders.aggregate([
                {"${'$'}lookup": {"from": "customers", "as": "c", "pipeline": [{"${'$'}match": {"active": true}}]}},
                {"${'$'}group": {"_id": "${'$'}status", "ids": {"${'$'}push": "${'$'}_id"}}}
            ])
            ```
        """.trimIndent()
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("orders", extraction.collection)
        assertTrue(extraction.pipelineJson.trim().startsWith("["))
        assertTrue(extraction.pipelineJson.trim().endsWith("]"))
        assertTrue(extraction.pipelineJson.contains("\$lookup"))
        assertTrue(extraction.pipelineJson.contains("\$group"))
    }

    @Test fun `does not get confused by a closing paren inside a string literal`() {
        val text = """db.notes.aggregate([{"${'$'}match": {"text": "see (details) below"}}])"""
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("notes", extraction.collection)
        assertTrue(extraction.pipelineJson.contains("see (details) below"))
    }

    @Test fun `does not get confused by an escaped quote inside a string literal`() {
        val text = """db.notes.aggregate([{"${'$'}match": {"text": "she said \"hi\")"}}])"""
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("notes", extraction.collection)
        assertTrue(extraction.pipelineJson.contains("she said"))
    }

    @Test fun `returns null when there is no aggregate call at all`() {
        assertNull(MongoExtract.extractPipeline("I'm not sure how to answer that."))
    }

    @Test fun `returns null when the aggregate argument is not an array`() {
        assertNull(MongoExtract.extractPipeline("db.orders.aggregate({\"\$match\": {}})"))
    }

    @Test fun `prefers the first fenced candidate that actually contains an aggregate call`() {
        val text = """
            ```js
            // just a comment, no query here
            ```
            ```js
            db.orders.aggregate([{"${'$'}count": "n"}])
            ```
        """.trimIndent()
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("orders", extraction.collection)
    }

    @Test fun `extracts a getCollection call for a hyphenated collection name`() {
        val text = """db.getCollection("user-events").aggregate([{"${'$'}count": "n"}])"""
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("user-events", extraction.collection)
    }

    @Test fun `extracts a getCollection call using single quotes`() {
        val text = """db.getCollection('user.events').aggregate([{"${'$'}count": "n"}])"""
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("user.events", extraction.collection)
    }

    @Test fun `extracts a bracket-string call for a hyphenated collection name`() {
        val text = """db["user-events"].aggregate([{"${'$'}count": "n"}])"""
        val extraction = MongoExtract.extractPipeline(text)!!
        assertEquals("user-events", extraction.collection)
    }

    @Test fun `impossible sentinel is reused from the shared Extract object, sentence-cased for the chat`() {
        assertEquals("No orders collection exists", Extract.extractImpossible("IMPOSSIBLE: no orders collection exists"))
    }
}
