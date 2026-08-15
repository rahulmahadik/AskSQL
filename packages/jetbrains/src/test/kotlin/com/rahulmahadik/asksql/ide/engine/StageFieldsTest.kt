package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.guard.MongoGuard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors packages/core/test/mongo-stage-fields.test.ts. */
class StageFieldsTest {

    private fun check(json: String) = StageFields.firstUnknownStageField(MongoGuard.parsePipeline(json))

    @Test
    fun `catches a field a group has already dropped`() {
        // The pipeline a 7b model wrote for "average amount rounded": $orders is the collection
        // name, and after the $group the document holds only _id and totalAmount.
        val found = check(
            """
            [
              {"${'$'}group": {"_id": null, "totalAmount": {"${'$'}sum": "${'$'}amount"}}},
              {"${'$'}project": {"averageAmount": {"${'$'}divide": ["${'$'}totalAmount", {"${'$'}size": "${'$'}orders"}]}, "_id": 0}}
            ]
            """.trimIndent(),
        )
        assertEquals("orders", found?.field)
        assertEquals(1, found?.stage)
        assertEquals(listOf("_id", "totalAmount"), found?.available)
    }

    @Test
    fun `accepts accumulator outputs and id after a group`() {
        assertNull(
            check(
                """
                [
                  {"${'$'}group": {"_id": "${'$'}region", "total": {"${'$'}sum": "${'$'}amount"}}},
                  {"${'$'}project": {"region": "${'$'}_id", "total": "${'$'}total", "_id": 0}},
                  {"${'$'}sort": {"total": -1}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `does not judge anything before a stage narrows the document`() {
        // The catalog is sampled, so a field missing from the sample is not evidence of absence.
        assertNull(check("""[{"${'$'}match": {"whatever": 1}}, {"${'$'}project": {"x": "${'$'}rarely_sampled"}}]"""))
    }

    @Test
    fun `reads accumulator expressions against the pre-group document`() {
        assertNull(
            check(
                """
                [
                  {"${'$'}group": {"_id": "${'$'}region", "n": {"${'$'}sum": 1}}},
                  {"${'$'}group": {"_id": null, "regions": {"${'$'}sum": "${'$'}n"}}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `counts addFields as producing its names`() {
        assertNull(
            check(
                """
                [
                  {"${'$'}group": {"_id": null, "total": {"${'$'}sum": "${'$'}amount"}}},
                  {"${'$'}addFields": {"doubled": {"${'$'}multiply": ["${'$'}total", 2]}}},
                  {"${'$'}project": {"doubled": "${'$'}doubled"}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `treats unset as a removal`() {
        val found = check(
            """
            [
              {"${'$'}group": {"_id": null, "total": {"${'$'}sum": "${'$'}amount"}, "n": {"${'$'}sum": 1}}},
              {"${'$'}unset": ["n"]},
              {"${'$'}project": {"x": "${'$'}n"}}
            ]
            """.trimIndent(),
        )
        assertEquals("n", found?.field)
    }

    @Test
    fun `adds the lookup output field and ignores the foreign sub-pipeline`() {
        // $_id inside the sub-pipeline belongs to reps, not to the grouped document.
        assertNull(
            check(
                """
                [
                  {"${'$'}group": {"_id": "${'$'}repId", "total": {"${'$'}sum": "${'$'}amount"}}},
                  {"${'$'}lookup": {"from": "reps", "let": {"r": "${'$'}_id"},
                                   "pipeline": [{"${'$'}match": {"${'$'}expr": {"${'$'}eq": ["${'$'}_id", "${'$'}${'$'}r"]}}}], "as": "rep"}},
                  {"${'$'}project": {"rep": "${'$'}rep", "total": "${'$'}total"}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `gives up rather than guessing after a stage it cannot model`() {
        val unmodelled = listOf(
            """{"${'$'}replaceRoot": {"newRoot": "${'$'}x"}}""",
            """{"${'$'}facet": {"a": []}}""",
            """{"${'$'}unionWith": "other"}""",
        )
        for (stage in unmodelled) {
            assertNull(
                check(
                    """[{"${'$'}group": {"_id": null, "t": {"${'$'}sum": "${'$'}a"}}}, $stage, {"${'$'}project": {"z": "${'$'}gone"}}]""",
                ),
            )
        }
    }

    @Test
    fun `leaves variables and literals alone`() {
        assertNull(
            check(
                """
                [
                  {"${'$'}group": {"_id": null, "t": {"${'$'}sum": "${'$'}amount"}}},
                  {"${'$'}project": {"now": "${'$'}${'$'}NOW", "label": "plain text", "t": "${'$'}t"}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `resolves a dotted path by its root`() {
        val found = check(
            """[{"${'$'}group": {"_id": null, "t": {"${'$'}sum": "${'$'}amount"}}}, {"${'$'}project": {"c": "${'$'}customer.city"}}]""",
        )
        assertEquals("customer", found?.field)
    }

    @Test
    fun `keeps the field after unwind`() {
        assertNull(
            check(
                """
                [
                  {"${'$'}group": {"_id": null, "items": {"${'$'}push": "${'$'}items"}}},
                  {"${'$'}unwind": "${'$'}items"},
                  {"${'$'}project": {"sku": "${'$'}items.sku"}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `narrows to the count output name`() {
        val found = check(
            """[{"${'$'}group": {"_id": "${'$'}region"}}, {"${'$'}count": "n"}, {"${'$'}project": {"x": "${'$'}region"}}]""",
        )
        assertEquals("region", found?.field)
        assertEquals(listOf("n"), found?.available)
    }

    private val fields = setOf("total amount", "customer-name", "Status", "_internal.created at", "plain")

    private fun misquoted(json: String) = StageFields.firstMisquotedField(MongoGuard.parsePipeline(json), fields)

    @Test
    fun `catches the backtick quoting a 7b model borrows from SQL`() {
        // MongoDB has no field quoting, so $sum over this returns 0 rather than failing.
        val found = misquoted("""[{"${'$'}group": {"_id": null, "t": {"${'$'}sum": "${'$'}`total amount`"}}}]""")
        assertEquals("`total amount`", found?.raw)
        assertEquals("total amount", found?.suggestion)
    }

    @Test
    fun `catches brackets too`() {
        assertEquals("customer-name", misquoted("""[{"${'$'}project": {"x": "${'$'}[customer-name]"}}]""")?.suggestion)
    }

    @Test
    fun `checks each segment of a dotted path`() {
        assertEquals(
            "_internal.created at",
            misquoted("""[{"${'$'}project": {"x": "${'$'}_internal.`created at`"}}]""")?.suggestion,
        )
    }

    @Test
    fun `leaves correct references alone`() {
        assertNull(misquoted("""[{"${'$'}group": {"_id": null, "t": {"${'$'}sum": "${'$'}total amount"}}}]"""))
        assertNull(misquoted("""[{"${'$'}project": {"x": "${'$'}plain", "y": "${'$'}${'$'}NOW"}}]"""))
    }

    @Test
    fun `stays silent when the unquoted name is not a catalog field either`() {
        // Without that proof the reference is merely unrecognised, and the catalog is only a sample.
        assertNull(misquoted("""[{"${'$'}project": {"x": "${'$'}`no such field`"}}]"""))
    }
}
