package com.rahulmahadik.asksql.ide.db.introspect

import org.bson.Document
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A document may use a map where the KEYS are data: `{ owed: { "ada@example.com": 120 } }`. Walked
 * naively every address becomes a column name, and a column name is never removed by the data opt-in, so
 * those addresses reached the prompt on the default path. A record repeats its fields across documents;
 * a map does not. Mirrors packages/mongodb/test/map-shaped-keys.test.ts.
 */
class MongoMapShapeTest {

    private fun names(docs: List<Document>) = MongoIntrospector.inferColumns(docs).map { it.name }
    private fun commentFor(docs: List<Document>, path: String) =
        MongoIntrospector.inferColumns(docs).firstOrNull { it.name == path }?.comment ?: ""

    private val ledger = listOf(
        Document("ref", "a").append("owed", Document("ada@example.com", 120).append("bob@corp.com", 40)),
        Document("ref", "b").append("owed", Document("grace@example.com", 80)),
        Document("ref", "c").append("owed", Document("linus@example.com", 5)),
    )

    @Test
    fun `an address never becomes a column name`() {
        val cols = names(ledger)
        assertTrue(cols.contains("owed"))
        for (who in listOf("ada", "bob", "grace", "linus")) {
            assertFalse("$who leaked: $cols", cols.joinToString(" ").contains(who))
        }
    }

    @Test
    fun `the shape is described instead`() {
        val comment = commentFor(ledger, "owed")
        assertTrue(comment, comment.contains("map-shaped"))
        assertTrue(comment, comment.contains("objectToArray"))
        assertFalse("a key leaked: $comment", comment.contains("@"))
    }

    @Test
    fun `the parent resolves even when the keys contain dots`() {
        // Splitting a path on its last dot lands inside "example.com", yielding a parent that does not
        // exist, so the check would skip exactly the shape it is for.
        assertTrue(names(ledger).none { it.startsWith("owed.") })
    }

    @Test
    fun `one field beside the keys does not shield them`() {
        // Judged per parent, a single summary field sitting beside the map vetoed the collapse and
        // every address stayed a column name. The judgement is per child.
        val docs = (0 until 50).map {
            Document("owed", Document("total", 100).append("user$it@example.com", 5))
        }
        val cols = names(docs)
        assertTrue(cols.toString(), cols.contains("owed.total"))
        assertFalse(cols.toString(), cols.joinToString(" ").contains("@example.com"))
    }

    @Test
    fun `keys inside an array element are dropped, where the parent is not typed object`() {
        val docs = (0 until 50).map { Document("payouts", listOf(Document("user$it@example.com", 1))) }
        assertFalse(names(docs).joinToString(" ").contains("@"))
    }

    @Test
    fun `keys seen in only one sampled document are dropped`() {
        val docs = (0 until 19).map { Document("ref", "x") } +
            Document("owed", Document("ada@example.com", 120).append("grace@example.com", 80))
        assertFalse(names(docs).joinToString(" ").contains("@"))
    }

    @Test
    fun `a map whose keys recur across many documents is still a map`() {
        // Judging recurrence by a pooled average only asks whether names average two documents each,
        // which any large map satisfies; recurrence rises with sample size.
        val slugs = (0 until 100).map { Document("usage", Document("ZZT${it % 30}", it)) }
        assertTrue(names(slugs).toString(), names(slugs).none { it.startsWith("usage.") })
        val users = (0 until 200).map { Document("reactions", Document("user_${it % 100}", "like")) }
        assertTrue(names(users).toString(), names(users).none { it.startsWith("reactions.") })
    }

    @Test
    fun `a record whose every field recurs is kept`() {
        val docs = (0 until 10).map { Document("address", Document("city", "C").append("zip", "1").append("street", "S")) }
        val cols = names(docs)
        for (f in listOf("address.city", "address.zip", "address.street")) assertTrue("$f dropped: $cols", cols.contains(f))
    }

    @Test
    fun `a polymorphic record is not mistaken for a map`() {
        // Payment details differ by method, so no child reaches 60% of the parent's documents - but the
        // names saturate, a few reused across many documents, which a map's keys never do.
        val docs = (0 until 40).map { Document("payment", Document("card_last4", "1234").append("card_brand", "visa")) } +
            (0 until 35).map { Document("payment", Document("paypal_email", "x")) } +
            (0 until 25).map { Document("payment", Document("bank_ref", "r")) }
        val cols = names(docs)
        for (f in listOf("payment.card_last4", "payment.card_brand", "payment.paypal_email", "payment.bank_ref")) {
            assertTrue("$f was deleted: $cols", cols.contains(f))
        }
    }

    @Test
    fun `a key containing dots is still a key`() {
        // A path cannot be split back into parent and child by text: "db.internal" has a first segment
        // that is also a real field, so the split stole it and only the field-shaped tail was judged.
        val docs = (0 until 5).map { Document("latency", Document("db", 1)) } +
            (0 until 5).map { Document("latency", Document("db.internal", 5)) }
        val cols = names(docs)
        assertTrue(cols.toString(), cols.contains("latency.db"))
        assertFalse(cols.toString(), cols.contains("latency.db.internal"))
    }

    @Test
    fun `the root is judged by shape alone`() {
        // One document per integration is ordinary and its names do not recur; judging the root by reuse
        // returned a catalog of just _id.
        val docs = listOf(
            Document("_id", 1).append("slack_webhook", "a").append("slack_channel", "b"),
            Document("_id", 2).append("github_token", "c").append("github_repo", "d"),
            Document("_id", 3).append("jira_url", "e").append("jira_project", "f"),
            Document("_id", 4).append("pager_key", "g").append("pager_team", "h"),
        )
        assertEquals(9, names(docs).size)
    }

    @Test
    fun `a field name that is not ASCII is kept`() {
        val docs = (0 until 40).map { Document("id", it).append("profile", Document("名前", "n$it").append("age", it)) }
        assertTrue(names(docs).toString(), names(docs).contains("profile.名前"))
    }

    @Test
    fun `a real record keeps every field it has`() {
        val people = listOf(
            Document("name", "Ada").append("address", Document("city", "Pune").append("zip", "411001")),
            Document("name", "Grace").append("address", Document("city", "Berlin").append("zip", "10115")),
            Document("name", "Linus").append("address", Document("city", "Oslo")),
        )
        val cols = names(people)
        assertTrue(cols.toString(), cols.contains("address.city"))
        assertTrue(cols.toString(), cols.contains("address.zip"))
        assertTrue(commentFor(people, "address").contains("present in 100%"))
    }

    @Test
    fun `a sub-document sampled from a single document keeps its field names`() {
        // With one document a record and a map are identical by reuse. Judging on that evidence deleted
        // the fields of every sub-document in a small sample; the key's shape still decides.
        val cols = names(listOf(Document("address", Document("city", "NYC").append("zip", "10001"))))
        assertTrue(cols.toString(), cols.contains("address.city"))
        assertTrue(cols.toString(), cols.contains("address.zip"))
    }

    @Test
    fun `keys that cannot be field names are dropped however small the sample`() {
        val cols = names(listOf(Document("owed", Document("ada@example.com", 120).append("grace@example.com", 80))))
        assertFalse(cols.toString(), cols.joinToString(" ").contains("@"))
    }

    @Test
    fun `a parent with one child is left alone, having shown nothing either way`() {
        val docs = (1..3).map { Document("meta", Document("version", it)) }
        assertTrue(names(docs).contains("meta.version"))
    }

    @Test
    fun `a parent keeping one recurring field is left alone`() {
        val docs = listOf(
            Document("cfg", Document("mode", "a").append("tmp_x", 1)),
            Document("cfg", Document("mode", "b").append("tmp_y", 2)),
            Document("cfg", Document("mode", "c").append("tmp_z", 3)),
        )
        assertTrue(names(docs).contains("cfg.mode"))
    }
}
