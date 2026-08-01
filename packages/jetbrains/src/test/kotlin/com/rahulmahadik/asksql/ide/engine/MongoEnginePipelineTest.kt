package com.rahulmahadik.asksql.ide.engine

import com.mongodb.client.MongoClients
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.guard.MongoGuard
import com.rahulmahadik.asksql.ide.llm.LlmClient
import com.rahulmahadik.asksql.ide.llm.LlmResult
import com.rahulmahadik.asksql.ide.llm.LlmUsage
import com.rahulmahadik.asksql.ide.llm.TokenListener
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.bson.Document
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import org.testcontainers.containers.MongoDBContainer

/**
 * [MongoClientRegistry] always opens a real [com.mongodb.client.MongoClient], so exercising
 * `ask()`'s repair loop needs a real MongoDB (Testcontainers) paired with a hand-rolled [LlmClient]
 * fake returning canned responses for deterministic repair attempts.
 */
@Category(IntegrationTest::class)
class MongoEnginePipelineTest {

    private lateinit var container: MongoDBContainer
    private val databaseName = "asksql_pipeline_test"

    @Before
    fun startContainer() {
        container = MongoDBContainer("mongo:7.0")
        container.start()
        MongoClients.create(container.getReplicaSetUrl(databaseName)).use { setup ->
            setup.getDatabase(databaseName).getCollection("orders")
                .insertMany(listOf(Document("status", "paid"), Document("status", "pending")))
        }
    }

    @After
    fun stopContainer() {
        container.stop()
    }

    private fun descriptor() = ConnectionDescriptor(
        id = "mongo-pipeline-test", name = "t", engine = EngineKind.MONGODB, scope = ConnectionScope.PROJECT,
        database = databaseName, connectionString = container.getReplicaSetUrl(databaseName),
    )

    private fun pipeline(): Pair<MongoEnginePipeline, InMemoryHistoryStore> {
        val registry = MongoClientRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val history = InMemoryHistoryStore()
        return MongoEnginePipeline(registry, history) to history
    }

    /** Returns each response in order, then repeats the last one - enough to drive both a "corrects on attempt N" and a "never corrects" test with the same shape. */
    private class FakeLlmClient(private val responses: List<String>) : LlmClient {
        var callCount = 0
            private set

        override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?): LlmResult {
            val text = responses[callCount.coerceAtMost(responses.size - 1)]
            callCount++
            return LlmResult(text, LlmUsage())
        }

        override suspend fun listModels(): List<String> = emptyList()
    }

    private class ThrowingLlmClient(private val error: Exception) : LlmClient {
        override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?): LlmResult = throw error
        override suspend fun listModels(): List<String> = emptyList()
    }

    private fun fence(pipelineJson: String) = "```js\ndb.orders.aggregate($pipelineJson)\n```"

    // ---- Repair loop: retries on guard rejection, then succeeds ----

    @Test
    fun `ask retries after a guard rejection and succeeds once the LLM produces a valid pipeline`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = FakeLlmClient(
            listOf(
                fence("""[{"${'$'}out": "evil"}]"""), // rejected: $out is not an allowed stage
                fence("""[{"${'$'}match": {"status": "paid"}}]"""), // valid on the second attempt
            ),
        )

        val result = pipeline.ask(question = "paid orders", descriptor = descriptor(), password = null, llmClient = llm)

        assertEquals("orders", result.collection)
        assertEquals(1, result.repairs)
        assertEquals(2, llm.callCount)
        assertTrue(result.pipelineJson.contains("\$match"))
    }

    // ---- Collection name casing: MongoDB collections ARE case-sensitive, so a model
    // response naming the collection with different casing than the catalog must
    // resolve to the catalog's real name, not query a nonexistent-but-similarly-named
    // collection and silently return zero rows. ----

    @Test
    fun `ask resolves a differently-cased collection name to the catalog's real casing`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = FakeLlmClient(listOf("```js\ndb.Orders.aggregate([{\"\$match\": {\"status\": \"paid\"}}])\n```"))

        val result = pipeline.ask(question = "paid orders", descriptor = descriptor(), password = null, llmClient = llm)

        assertEquals("expected the catalog's real casing, not the model's \"Orders\"", "orders", result.collection)
        assertEquals(0, result.repairs)
    }

    // ---- MAX_REPAIRS exhaustion on a guard rejection ----

    @Test
    fun `ask throws GUARD_BLOCKED after MAX_REPAIRS repeated guard rejections`() = runTest {
        val (pipeline, history) = pipeline()
        val llm = FakeLlmClient(listOf(fence("""[{"${'$'}out": "evil"}]""")))

        var thrownCode: AskSqlErrorCode? = null
        try {
            pipeline.ask(question = "delete everything", descriptor = descriptor(), password = null, llmClient = llm)
            fail("expected GUARD_BLOCKED after repeated guard rejections")
        } catch (e: AskSqlException) {
            thrownCode = e.code
        }
        assertEquals(AskSqlErrorCode.GUARD_BLOCKED, thrownCode)
        assertEquals(3, llm.callCount) // attempts 0, 1, 2 (MAX_REPAIRS = 2)
        assertTrue(history.recent().any { it.question == "delete everything" && it.status == HistoryStatus.BLOCKED })
    }

    // ---- IMPOSSIBLE sentinel ----

    @Test
    fun `ask throws a non-retryable LLM_CANNOT_ANSWER when the model reports the question is impossible`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = FakeLlmClient(listOf("IMPOSSIBLE: no such data exists in this schema"))

        var thrown: AskSqlException? = null
        try {
            pipeline.ask(question = "predict the future", descriptor = descriptor(), password = null, llmClient = llm)
            fail("expected LLM_CANNOT_ANSWER for the IMPOSSIBLE sentinel")
        } catch (e: AskSqlException) {
            thrown = e
        }
        assertNotNull(thrown)
        assertEquals(AskSqlErrorCode.LLM_CANNOT_ANSWER, thrown!!.code)
        assertFalse(thrown.retryable)
    }

    // ---- Collection-doesn't-exist floor ----

    @Test
    fun `ask throws LLM_BAD_OUTPUT after MAX_REPAIRS when the LLM keeps referencing a nonexistent collection`() = runTest {
        val (pipeline, _) = pipeline()
        // Same (guarded-valid) pipeline every time, but against a collection absent from the catalog.
        val llm = FakeLlmClient(listOf("```js\ndb.ghost.aggregate([{\"\$match\": {}}])\n```"))

        var thrown: AskSqlException? = null
        try {
            pipeline.ask(question = "ghost data", descriptor = descriptor(), password = null, llmClient = llm)
            fail("expected LLM_BAD_OUTPUT once the unknown collection floor is hit after MAX_REPAIRS")
        } catch (e: AskSqlException) {
            thrown = e
        }
        assertNotNull(thrown)
        assertEquals(AskSqlErrorCode.LLM_BAD_OUTPUT, thrown!!.code)
        assertFalse(thrown.retryable)
        assertEquals(3, llm.callCount)
    }

    // ---- suggestFix contract ----

    @Test
    fun `suggestFix returns null when the LLM produces the same pipeline unchanged`() = runTest {
        val (pipeline, _) = pipeline()
        // Guard once ourselves to get the EXACT serialized (already-limited) form; guarding it
        // again must reproduce the identical string for this to prove anything.
        val original = MongoGuard.guard("""[{"${'$'}match": {"status": "paid"}}]""").pipelineJson
        val llm = FakeLlmClient(listOf(fence(original)))

        val fix = pipeline.suggestFix(
            failedPipeline = original, descriptor = descriptor(), password = null,
            question = "paid orders", errorDetail = "timeout", llmClient = llm,
        )
        assertNull("expected null since the repaired pipeline is identical to the original", fix)
    }

    @Test
    fun `suggestFix returns null on any thrown exception, best-effort`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = ThrowingLlmClient(RuntimeException("provider exploded"))

        val fix = pipeline.suggestFix(
            failedPipeline = """[{"${'$'}match": {}}]""", descriptor = descriptor(), password = null,
            question = "paid orders", errorDetail = "timeout", llmClient = llm,
        )
        assertNull(fix)
    }

    @Test
    fun `suggestFix returns the corrected pipeline and collection when the LLM successfully repairs`() = runTest {
        val (pipeline, _) = pipeline()
        val bad = """[{"${'$'}match": {"status": "paid"}, "extra": 1}]""" // malformed filter the DB rejected
        val llm = FakeLlmClient(listOf(fence("""[{"${'$'}match": {"status": "paid"}}]""")))

        val fix = pipeline.suggestFix(
            failedPipeline = bad, descriptor = descriptor(), password = null,
            question = "paid orders", errorDetail = "bad filter", llmClient = llm,
        )
        assertNotNull(fix)
        assertEquals("orders", fix!!.collection)
        assertTrue(fix.pipelineJson.contains("\$match"))
        assertTrue(fix.pipelineJson != bad)
    }

    // ---- Cancellation must propagate unwrapped, not get misreported as an LLM/DB failure ----

    @Test
    fun `ask propagates a CancellationException raised mid-chat rather than misreporting it as an LLM failure`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = ThrowingLlmClient(kotlinx.coroutines.CancellationException("simulated user cancel"))

        var thrown: Throwable? = null
        try {
            pipeline.ask(question = "paid orders", descriptor = descriptor(), password = null, llmClient = llm)
        } catch (e: Throwable) {
            thrown = e
        }
        assertTrue("expected the real CancellationException to propagate unwrapped, got: $thrown", thrown is kotlinx.coroutines.CancellationException)
    }

    @Test
    fun `suggestFix propagates a CancellationException rather than treating it as no-fix-available`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = ThrowingLlmClient(kotlinx.coroutines.CancellationException("simulated user cancel"))

        var thrown: Throwable? = null
        try {
            pipeline.suggestFix(
                failedPipeline = """[{"${'$'}match": {}}]""", descriptor = descriptor(), password = null,
                question = "paid orders", errorDetail = "timeout", llmClient = llm,
            )
        } catch (e: Throwable) {
            thrown = e
        }
        assertTrue("expected the real CancellationException to propagate unwrapped, got: $thrown", thrown is kotlinx.coroutines.CancellationException)
    }

    /** suggestFix must enforce the same collection-existence floor ask() does - a "fix" naming a nonexistent collection would just fail (or silently return zero rows) once re-approved. */
    @Test
    fun `suggestFix returns null when the repaired pipeline references a nonexistent collection`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = FakeLlmClient(listOf("```js\ndb.ghost.aggregate([{\"\$match\": {}}])\n```"))

        val fix = pipeline.suggestFix(
            failedPipeline = """[{"${'$'}match": {}}]""", descriptor = descriptor(), password = null,
            question = "ghost data", errorDetail = "timeout", llmClient = llm,
        )
        assertNull(fix)
    }

    /** suggestFix must resolve the collection's real catalog casing, same as ask() - see ask()'s casing-resolution comment for why. */
    @Test
    fun `suggestFix resolves a differently-cased collection name to the catalog's real casing`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = FakeLlmClient(listOf("```js\ndb.Orders.aggregate([{\"\$match\": {\"status\": \"paid\"}}])\n```"))

        val fix = pipeline.suggestFix(
            failedPipeline = """[{"${'$'}match": {"status": "paid"}, "extra": 1}]""", descriptor = descriptor(), password = null,
            question = "paid orders", errorDetail = "bad filter", llmClient = llm,
        )
        assertNotNull(fix)
        assertEquals("expected the catalog's real casing, not the model's \"Orders\"", "orders", fix!!.collection)
    }

    // ---- explainSchema: the prose path the chat panel falls back to ----

    @Test
    fun `explainSchema answers in prose without running an aggregation`() = runTest {
        val (pipeline, history) = pipeline()
        val llm = FakeLlmClient(listOf("The `orders` collection holds one document per order, with a `status` field."))

        val sa = pipeline.explainSchema("what is this database for?", descriptor(), null, llm)

        assertTrue(sa.answer.contains("orders"))
        assertTrue(sa.tables.contains("orders"))
        assertFalse(sa.isSchemaChange)
        assertTrue("no query may run for a schema question", history.recent().isEmpty())
    }

    @Test
    fun `explainSchema declines a question with nothing to do with data`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = FakeLlmClient(listOf("OUT_OF_SCOPE"))

        val sa = pipeline.explainSchema("tell me a joke about penguins", descriptor(), null, llm)

        assertTrue(sa.answer.contains("only help with databases"))
        assertTrue("the decline names the engine", sa.answer.contains("MongoDB"))
        assertFalse(sa.answer.contains("OUT_OF_SCOPE"))
        assertEquals("no retry: the question has no database vocabulary", 1, llm.callCount)
    }

    @Test
    fun `explainSchema challenges a refusal when the question is plainly about data`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = FakeLlmClient(
            listOf("OUT_OF_SCOPE", "This connection is MongoDB: use a `${'$'}lookup` stage rather than a SQL JOIN on `orders`."),
        )

        val sa = pipeline.explainSchema("how do I write a SQL JOIN here?", descriptor(), null, llm)

        assertEquals(2, llm.callCount)
        assertTrue(sa.answer.contains("lookup"))
        assertFalse(sa.answer.contains("only help with databases"))
    }

    @Test
    fun `explainSchema marks a proposed write as never executed`() = runTest {
        val (pipeline, _) = pipeline()
        val llm = FakeLlmClient(listOf("Run db.orders.deleteMany({ status: \"cancelled\" }) to remove them."))

        val sa = pipeline.explainSchema("delete all cancelled orders", descriptor(), null, llm)

        assertTrue(sa.isSchemaChange)
        assertTrue(sa.answer.contains("read-only", ignoreCase = true))
    }

    @Test
    fun `explainSchema grounds against the catalog without flagging MongoDB operators`() = runTest {
        val (pipeline, _) = pipeline()
        val good = FakeLlmClient(listOf("Join with `${'$'}lookup`; the `orders` collection has a `status` field."))
        assertTrue(pipeline.explainSchema("how are these related?", descriptor(), null, good).grounded)

        val invented = FakeLlmClient(listOf("Older documents live in the `order_history` collection."))
        val sa = pipeline.explainSchema("where is history kept?", descriptor(), null, invented)
        assertFalse(sa.grounded)
        assertTrue(sa.unknownReferences.contains("order_history"))
    }

    @Test
    fun `explainSchema rejects a question longer than the cap`() = runTest {
        val (pipeline, _) = pipeline()
        try {
            pipeline.explainSchema("x".repeat(10_001), descriptor(), null, FakeLlmClient(listOf("unused")))
            fail("expected the length cap to reject this")
        } catch (e: AskSqlException) {
            assertEquals(AskSqlErrorCode.INVALID_INPUT, e.code)
        }
    }
}
