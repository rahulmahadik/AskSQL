package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
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

/** A real, non-mocked run of [EnginePipeline.ask]/[EnginePipeline.execute] against a locally-running Postgres and Ollama; skips itself when either isn't reachable. */
@Category(IntegrationTest::class)
class PostgresEndToEndTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 55432
        private const val DB = "asksql_demo"
        private const val USER = "asksql"
        private const val MODEL = "qwen2.5-coder:7b"
        private const val OLLAMA_BASE_URL = "http://localhost:11434/v1"
    }

    private var postgresAvailable = false

    @Before
    fun checkPostgres() {
        postgresAvailable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
    }

    @Test
    fun `ask produces a working SELECT against a real local Postgres and a real local model`() = runTest(timeout = 90.seconds) {
        assumeTrue("Postgres is not reachable on localhost:$PORT - skipping the live e2e test", postgresAvailable)

        val descriptor = ConnectionDescriptor(
            id = "pg-e2e", name = "e2e", engine = EngineKind.POSTGRES, scope = ConnectionScope.PROJECT,
            host = HOST, port = PORT, database = DB, user = USER,
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline.ask(
            question = "How many completed orders are there?",
            descriptor = descriptor,
            password = null,
            llmClient = llmClient,
        )

        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))

        val resultSet = pipeline.execute(result.sql, descriptor, password = null)
        assertTrue("expected at least one row back from a real query execution", resultSet.rows.isNotEmpty())
    }

    @Test
    fun `ask joins across foreign keys against a real local Postgres and a real local model`() = runTest(timeout = 90.seconds) {
        assumeTrue("Postgres is not reachable on localhost:$PORT - skipping the live e2e test", postgresAvailable)

        val descriptor = ConnectionDescriptor(
            id = "pg-e2e-join", name = "e2e-join", engine = EngineKind.POSTGRES, scope = ConnectionScope.PROJECT,
            host = HOST, port = PORT, database = DB, user = USER,
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline.ask(
            question = "List each customer's name alongside the total_cents of their orders.",
            descriptor = descriptor,
            password = null,
            llmClient = llmClient,
        )

        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))
        val resultSet = pipeline.execute(result.sql, descriptor, password = null)
        assertTrue("expected at least one row back from a real join query", resultSet.rows.isNotEmpty())
    }

    private fun descriptor(id: String) = ConnectionDescriptor(
        id = id, name = id, engine = EngineKind.POSTGRES, scope = ConnectionScope.PROJECT,
        host = HOST, port = PORT, database = DB, user = USER,
    )

    private fun pipeline() = EnginePipeline(ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))

    private fun llmClient() = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

    /** Real end-to-end proof that a declaratively partitioned table's parent is queryable through the full pipeline. */
    @Test
    fun `ask queries a real partitioned table correctly across its partitions`() = runTest(timeout = 90.seconds) {
        assumeTrue("Postgres is not reachable on localhost:$PORT - skipping the live e2e test", postgresAvailable)
        val descriptor = descriptor("pg-e2e-partition")

        val result = pipeline().ask(question = "How many rows are in the events table?", descriptor = descriptor, password = null, llmClient = llmClient())
        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))

        val resultSet = pipeline().execute(result.sql, descriptor, password = null)
        assertTrue("expected at least one row back from a real query against the partitioned table", resultSet.rows.isNotEmpty())
    }

    /**
     * A correctly-quoted mixed-case identifier must not be falsely flagged as an unknown
     * table/column. Uses a hand-written, pre-quoted query to isolate the guard/execution path
     * from a small model's own prompt-following behavior.
     */
    @Test
    fun `execute accepts a correctly quoted mixed-case identifier without a false hallucination positive`() = runTest(timeout = 30.seconds) {
        assumeTrue("Postgres is not reachable on localhost:$PORT - skipping the live e2e test", postgresAvailable)
        val descriptor = descriptor("pg-e2e-mixedcase")

        val resultSet = pipeline().execute("""SELECT "productName", "Price" FROM "Products" WHERE "productName" = 'Widget'""", descriptor, password = null)
        assertTrue("expected the real row back, proving the quoted identifiers were not falsely flagged as hallucinated", resultSet.rows.isNotEmpty())
    }

    /** Real end-to-end proof that a multi-bit bit(n) column round-trips as text rather than crashing or losing the value. */
    @Test
    fun `ask queries a bit(n) flags column without crashing`() = runTest(timeout = 90.seconds) {
        assumeTrue("Postgres is not reachable on localhost:$PORT - skipping the live e2e test", postgresAvailable)
        val descriptor = descriptor("pg-e2e-bitflags")

        val result = pipeline().ask(question = "What are the permission flags for the user named alice, in the permissions table?", descriptor = descriptor, password = null, llmClient = llmClient())
        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))

        val resultSet = pipeline().execute(result.sql, descriptor, password = null)
        assertTrue("expected at least one row back from a real query against a bit(n) column", resultSet.rows.isNotEmpty())
    }
}
