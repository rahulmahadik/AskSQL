package com.rahulmahadik.asksql.ide.db.introspect

import org.bson.Document
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Exercises [MongoIntrospector.inferColumns] directly against in-memory
 * sample documents; no live MongoDB instance needed, since this is a pure
 * function over already-fetched samples (fetching them is the only part
 * that needs a real connection).
 */
class MongoIntrospectorTest {

    @Test fun `infers a scalar field present in every sample`() {
        val samples = listOf(Document("name", "Ava"), Document("name", "Ben"))
        val columns = MongoIntrospector.inferColumns(samples)
        val name = columns.first { it.name == "name" }
        assertEquals("string", name.dbType)
        assertFalse(name.nullable)
        assertTrue(name.comment!!.contains("100%"))
    }

    @Test fun `marks a sometimes-absent field nullable with an accurate presence rate`() {
        val samples = listOf(Document("name", "Ava"), Document("name", "Ben").append("nickname", "Benny"))
        val columns = MongoIntrospector.inferColumns(samples)
        val nickname = columns.first { it.name == "nickname" }
        assertTrue(nickname.nullable)
        assertTrue(nickname.comment!!.contains("50%"))
    }

    @Test fun `marks a field holding a real null as nullable even if always present`() {
        val samples = listOf(Document("mid", null), Document("mid", null))
        val columns = MongoIntrospector.inferColumns(samples)
        assertTrue(columns.first { it.name == "mid" }.nullable)
    }

    @Test fun `flattens a nested sub-document into dotted paths`() {
        val samples = listOf(Document("address", Document("city", "NYC").append("zip", "10001")))
        val columns = MongoIntrospector.inferColumns(samples)
        assertTrue(columns.any { it.name == "address" })
        assertTrue(columns.any { it.name == "address.city" })
        assertTrue(columns.any { it.name == "address.zip" })
    }

    @Test fun `flattens an array of sub-documents but not an array of scalars`() {
        val samples = listOf(
            Document("tags", listOf("a", "b"))
                .append("items", listOf(Document("sku", "X1"), Document("sku", "X2"))),
        )
        val columns = MongoIntrospector.inferColumns(samples)
        assertEquals("array<string>", columns.first { it.name == "tags" }.dbType)
        assertFalse("a scalar array must not be flattened into tags.<n>", columns.any { it.name.startsWith("tags.") })
        assertTrue("an array of sub-documents should flatten its element fields", columns.any { it.name == "items.sku" })
    }

    @Test fun `reports mixed types across samples honestly instead of picking one`() {
        val samples = listOf(Document("value", 1), Document("value", "one"))
        val columns = MongoIntrospector.inferColumns(samples)
        val value = columns.first { it.name == "value" }
        assertTrue(value.dbType.startsWith("mixed("))
        assertTrue(value.dbType.contains("int32"))
        assertTrue(value.dbType.contains("string"))
    }

    @Test fun `caps sampled example values at 20 and omits them beyond that`() {
        val samples = (1..25).map { Document("code", "v$it") }
        val columns = MongoIntrospector.inferColumns(samples)
        assertTrue(columns.first { it.name == "code" }.sampledValues.isEmpty())
    }

    @Test fun `returns an empty column list for zero samples rather than throwing`() {
        assertTrue(MongoIntrospector.inferColumns(emptyList()).isEmpty())
    }

    /** A map-shaped collection (one key per id) must not grow one inferred column per key. */
    @Test fun `field inference is bounded for documents keyed by arbitrary ids`() {
        val wide = Document()
        repeat(5_000) { wide.append("user_$it", "value") }
        val columns = MongoIntrospector.inferColumns(listOf(wide))
        assertTrue("expected a bounded column count, got ${columns.size}", columns.size <= 500)
    }

    @Test fun `objectId and date values are typed distinctly from string`() {
        val samples = listOf(
            Document("_id", org.bson.types.ObjectId())
                .append("createdAt", java.util.Date()),
        )
        val columns = MongoIntrospector.inferColumns(samples)
        assertEquals("objectId", columns.first { it.name == "_id" }.dbType)
        assertEquals("date", columns.first { it.name == "createdAt" }.dbType)
    }
}
