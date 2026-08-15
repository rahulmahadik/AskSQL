package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.guard.MongoGuard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors packages/core/test/mongo-normalise.test.ts. */
class MongoNormaliseTest {

    private fun rewrite(json: String) =
        MongoNormalise.rewriteDistinctCount(MongoGuard.parsePipeline(json))?.joinToString(",", "[", "]") { it.toJson() }

    private fun compact(json: String) =
        MongoGuard.parsePipeline(json).joinToString(",", "[", "]") { it.toJson() }

    @Test
    fun `rewrites the addToSet plus size idiom into a grouped count`() {
        assertEquals(
            compact("""[{"${'$'}match": {"region": {"${'$'}exists": true}}}, {"${'$'}group": {"_id": "${'$'}region"}}, {"${'$'}count": "n"}]"""),
            rewrite(
                """
                [
                  {"${'$'}group": {"_id": null, "distinctRegions": {"${'$'}addToSet": "${'$'}region"}}},
                  {"${'$'}project": {"_id": 0, "n": {"${'$'}size": "${'$'}distinctRegions"}}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `keeps the stages that follow`() {
        assertEquals(
            compact("""[{"${'$'}match": {"region": {"${'$'}exists": true}}}, {"${'$'}group": {"_id": "${'$'}region"}}, {"${'$'}count": "n"}, {"${'$'}limit": 1000}]"""),
            rewrite(
                """
                [
                  {"${'$'}group": {"_id": null, "s": {"${'$'}addToSet": "${'$'}region"}}},
                  {"${'$'}project": {"n": {"${'$'}size": "${'$'}s"}}},
                  {"${'$'}limit": 1000}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `accepts addFields and set in place of project`() {
        for (stage in listOf("\$addFields", "\$set")) {
            assertEquals(
                compact("""[{"${'$'}match": {"region": {"${'$'}exists": true}}}, {"${'$'}group": {"_id": "${'$'}region"}}, {"${'$'}count": "n"}]"""),
                rewrite(
                    """[{"${'$'}group": {"_id": null, "s": {"${'$'}addToSet": "${'$'}region"}}}, {"$stage": {"n": {"${'$'}size": "${'$'}s"}}}]""",
                ),
            )
        }
    }

    @Test
    fun `refuses a grouped distinct count, which asks a different question`() {
        // Per-region distinct reps is not the same as the number of distinct reps.
        assertNull(
            rewrite(
                """
                [
                  {"${'$'}group": {"_id": "${'$'}region", "reps": {"${'$'}addToSet": "${'$'}rep"}}},
                  {"${'$'}project": {"n": {"${'$'}size": "${'$'}reps"}}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `refuses when the group carries anything else`() {
        assertNull(
            rewrite(
                """
                [
                  {"${'$'}group": {"_id": null, "s": {"${'$'}addToSet": "${'$'}region"}, "total": {"${'$'}sum": "${'$'}amount"}}},
                  {"${'$'}project": {"n": {"${'$'}size": "${'$'}s"}}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `refuses when the array is read more than once`() {
        assertNull(
            rewrite(
                """
                [
                  {"${'$'}group": {"_id": null, "s": {"${'$'}addToSet": "${'$'}region"}}},
                  {"${'$'}project": {"n": {"${'$'}size": "${'$'}s"}, "values": "${'$'}s"}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `refuses when a later stage still needs the array`() {
        assertNull(
            rewrite(
                """
                [
                  {"${'$'}group": {"_id": null, "s": {"${'$'}addToSet": "${'$'}region"}}},
                  {"${'$'}project": {"n": {"${'$'}size": "${'$'}s"}}},
                  {"${'$'}match": {"${'$'}expr": {"${'$'}in": ["North", "${'$'}s"]}}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `refuses push, which does not deduplicate`() {
        assertNull(
            rewrite(
                """[{"${'$'}group": {"_id": null, "s": {"${'$'}push": "${'$'}region"}}}, {"${'$'}project": {"n": {"${'$'}size": "${'$'}s"}}}]""",
            ),
        )
    }

    @Test
    fun `refuses an expression in place of a plain field path`() {
        assertNull(
            rewrite(
                """
                [
                  {"${'$'}group": {"_id": null, "s": {"${'$'}addToSet": {"${'$'}toUpper": "${'$'}region"}}}},
                  {"${'$'}project": {"n": {"${'$'}size": "${'$'}s"}}}
                ]
                """.trimIndent(),
            ),
        )
    }

    @Test
    fun `refuses anything that is not this exact shape`() {
        assertNull(rewrite("[]"))
        assertNull(rewrite("""[{"${'$'}group": {"_id": null, "s": {"${'$'}addToSet": "${'$'}region"}}}]"""))
        assertNull(rewrite("""[{"${'$'}match": {"a": 1}}, {"${'$'}count": "n"}]"""))
        assertNull(
            rewrite(
                """[{"${'$'}group": {"_id": null, "s": {"${'$'}addToSet": "${'$'}region"}}}, {"${'$'}project": {"n": {"${'$'}sum": "${'$'}s"}}}]""",
            ),
        )
    }
}
