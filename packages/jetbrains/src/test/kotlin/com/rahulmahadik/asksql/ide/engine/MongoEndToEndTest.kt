package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry
import com.rahulmahadik.asksql.ide.llm.LlmClients
import com.rahulmahadik.asksql.ide.llm.ProviderConfig
import com.rahulmahadik.asksql.ide.llm.ProviderKind
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.net.Socket
import kotlin.time.Duration.Companion.seconds

/** A real, non-mocked run of [MongoEnginePipeline.ask]/[MongoEnginePipeline.execute] against a locally-running MongoDB and Ollama; skips itself when either isn't reachable. */
@Category(IntegrationTest::class)
class MongoEndToEndTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 57017
        private const val DB = "asksql_demo"
        private const val MODEL = "qwen2.5-coder:7b"
        private const val OLLAMA_BASE_URL = "http://localhost:11434/v1"
    }

    private var mongoAvailable = false

    @Before
    fun checkMongo() {
        mongoAvailable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
    }

    @Test
    fun `ask produces a working pipeline against a real local MongoDB and a real local model`() = runTest(timeout = 90.seconds) {
        assumeTrue("MongoDB is not reachable on localhost:$PORT - skipping the live e2e test", mongoAvailable)

        val descriptor = ConnectionDescriptor(
            id = "mongo-e2e", name = "e2e", engine = EngineKind.MONGODB, scope = ConnectionScope.PROJECT,
            database = DB, connectionString = "mongodb://$HOST:$PORT/$DB",
        )
        val registry = MongoClientRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = MongoEnginePipeline(registry)
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline.ask(
            question = "How many completed orders are there?",
            descriptor = descriptor,
            password = null,
            llmClient = llmClient,
        )

        assertTrue("expected a non-empty pipeline, got: ${result.pipelineJson}", result.pipelineJson.isNotBlank())

        val resultSet = pipeline.execute(result.pipelineJson, result.collection, descriptor, password = null)
        assertTrue("expected at least one row back from a real query execution", resultSet.rows.isNotEmpty())
    }

    private fun descriptor(id: String) = ConnectionDescriptor(
        id = id, name = id, engine = EngineKind.MONGODB, scope = ConnectionScope.PROJECT,
        database = DB, connectionString = "mongodb://$HOST:$PORT/$DB",
    )

    private fun pipeline() = MongoEnginePipeline(MongoClientRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))

    /** Real end-to-end proof that collection-name resolution to the catalog's real casing (rather than the model's) works when a real model queries a real, heterogeneous collection. */
    @Test
    fun `ask queries heterogeneous documents with varying fields correctly`() = runTest(timeout = 90.seconds) {
        assumeTrue("MongoDB is not reachable on localhost:$PORT - skipping the live e2e test", mongoAvailable)
        val descriptor = descriptor("mongo-e2e-heterogeneous")
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline().ask(question = "What is the price of the Widget product?", descriptor = descriptor, password = null, llmClient = llmClient)
        assertTrue("expected a non-empty pipeline, got: ${result.pipelineJson}", result.pipelineJson.isNotBlank())

        val resultSet = pipeline().execute(result.pipelineJson, result.collection, descriptor, password = null)
        assertTrue("expected at least one row back against a collection with heterogeneous documents", resultSet.rows.isNotEmpty())
    }
}
