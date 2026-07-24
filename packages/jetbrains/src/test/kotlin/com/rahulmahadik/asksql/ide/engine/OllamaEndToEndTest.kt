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
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Properties
import kotlin.time.Duration.Companion.seconds

/** A real, non-mocked run of [EnginePipeline.ask]/[EnginePipeline.execute] against a locally-running Ollama; skips itself via [assumeTrue] when Ollama isn't reachable. */
@Category(IntegrationTest::class)
class OllamaEndToEndTest {

    companion object {
        private const val OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"
        private const val OLLAMA_BASE_URL = "http://localhost:11434/v1"
        // A small, fast coder model; picked for turnaround time in a test, not capability;
        // any of the locally-pulled qwen2.5-coder variants exercise the same pipeline.
        private const val MODEL = "qwen2.5-coder:7b"
    }

    private var ollamaAvailable = false

    @Before
    fun checkOllama() {
        ollamaAvailable = try {
            val client = HttpClient.newHttpClient()
            val request = HttpRequest.newBuilder(URI.create(OLLAMA_TAGS_URL)).GET().timeout(Duration.ofSeconds(2)).build()
            val response = client.send(request, HttpResponse.BodyHandlers.ofString())
            response.statusCode() == 200 && response.body().contains(MODEL)
        } catch (e: Exception) {
            false
        }
    }

    private fun sampleDb(): File {
        val file = File.createTempFile("asksql-e2e", ".sqlite")
        file.deleteOnExit()
        // A plain (non-read-only) connection to seed data; JdbcConnectionFactory
        // always opens the plugin's own connections read-only, so seeding must
        // happen through a separate, throwaway connection first.
        org.sqlite.JDBC().connect("jdbc:sqlite:${file.path}", Properties())!!.use { seed ->
            seed.createStatement().use { st ->
                st.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL)")
                st.execute("INSERT INTO customers (name, country) VALUES ('Ava', 'US'), ('Ben', 'UK'), ('Cy', 'US')")
            }
        }
        return file
    }

    @Test
    fun `ask produces a working SELECT against a real local model and a real database`() = runTest(timeout = 90.seconds) {
        assumeTrue("Ollama is not running locally with $MODEL pulled - skipping the live LLM smoke test", ollamaAvailable)

        val dbFile = sampleDb()
        val descriptor = ConnectionDescriptor(
            id = "ollama-e2e-sqlite",
            name = "e2e",
            engine = EngineKind.SQLITE,
            scope = ConnectionScope.PROJECT,
            filePath = dbFile.path,
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline.ask(
            question = "How many customers are from the US?",
            descriptor = descriptor,
            password = null,
            llmClient = llmClient,
        )

        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))

        val resultSet = pipeline.execute(result.sql, descriptor, password = null)
        assertTrue("expected at least one row back from a real query execution", resultSet.rows.isNotEmpty())
    }
}
