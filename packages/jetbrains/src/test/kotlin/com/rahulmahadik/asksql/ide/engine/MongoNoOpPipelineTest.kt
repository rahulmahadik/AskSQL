package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin half of core's `mongo-noop-pipeline.test.ts`. A pipeline that only slices runs and
 * returns arbitrary documents, so a model dodging the question that way would read as an answer.
 */
class MongoNoOpPipelineTest {

    @Test
    fun `a slice-only pipeline selects nothing`() {
        for (pipeline in listOf(
            """[{"${'$'}limit": 1000}]""",
            """[{"${'$'}skip": 0}, {"${'$'}limit": 50}]""",
            """[{"${'$'}sort": {"_id": 1}}, {"${'$'}limit": 10}]""",
            """[{"${'$'}sample": {"size": 5}}]""",
            "[]",
        )) {
            assertTrue(pipeline, MongoEnginePipeline.isNoOpPipeline(pipeline))
        }
    }

    @Test
    fun `a pipeline that filters, groups or projects is a real answer`() {
        for (pipeline in listOf(
            """[{"${'$'}match": {"status": "paid"}}, {"${'$'}limit": 1000}]""",
            """[{"${'$'}group": {"_id": "${'$'}status", "n": {"${'$'}sum": 1}}}]""",
            """[{"${'$'}project": {"status": 1}}, {"${'$'}limit": 10}]""",
            """[{"${'$'}lookup": {"from": "customers", "localField": "customerId", "foreignField": "_id", "as": "c"}}]""",
        )) {
            assertFalse(pipeline, MongoEnginePipeline.isNoOpPipeline(pipeline))
        }
    }

    /** Unparsable input belongs to the guard, not to this check. */
    @Test
    fun `nothing is reported for input this check cannot read`() {
        assertFalse(MongoEnginePipeline.isNoOpPipeline("not json at all"))
        assertFalse(MongoEnginePipeline.isNoOpPipeline("""{"${'$'}limit": 5}"""))
    }
}
