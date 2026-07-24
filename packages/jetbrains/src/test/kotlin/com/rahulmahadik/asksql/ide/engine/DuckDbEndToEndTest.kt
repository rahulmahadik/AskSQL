package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.DriverProvisioner
import com.rahulmahadik.asksql.ide.db.DuckDbFileLoader
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

/** A real, non-mocked run of [EnginePipeline.ask]/[EnginePipeline.execute] against DuckDB's real lazy-downloaded driver and a locally-running Ollama model; skips itself when Ollama isn't reachable. */
@Category(IntegrationTest::class)
class DuckDbEndToEndTest {

    companion object {
        private const val OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"
        private const val OLLAMA_BASE_URL = "http://localhost:11434/v1"
        private const val MODEL = "qwen2.5-coder:7b"
    }

    private var ollamaAvailable = false
    private lateinit var dbFile: File

    @Before
    fun setup() = runTest {
        ollamaAvailable = try {
            val client = HttpClient.newHttpClient()
            val request = HttpRequest.newBuilder(URI.create(OLLAMA_TAGS_URL)).GET().timeout(Duration.ofSeconds(2)).build()
            val response = client.send(request, HttpResponse.BodyHandlers.ofString())
            response.statusCode() == 200 && response.body().contains(MODEL)
        } catch (e: Exception) {
            false
        }

        dbFile = File.createTempFile("asksql-duckdb-e2e", ".duckdb")
        dbFile.delete()
        val driver = DriverProvisioner.duckDbDriver()
        driver.connect("jdbc:duckdb:${dbFile.path}", Properties())!!.use { connection ->
            connection.createStatement().use { st ->
                st.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL)")
                st.execute("INSERT INTO customers VALUES (1, 'Ava', 'US'), (2, 'Ben', 'UK'), (3, 'Cy', 'US')")
            }
        }
    }

    private fun descriptor() = ConnectionDescriptor(
        id = "duckdb-e2e", name = "e2e", engine = EngineKind.DUCKDB, scope = ConnectionScope.PROJECT,
        filePath = dbFile.path,
    )

    @Test
    fun `ask produces a working SELECT against the real DuckDB driver and a real local model`() = runTest(timeout = 90.seconds) {
        assumeTrue("Ollama is not running locally with $MODEL pulled - skipping the live e2e test", ollamaAvailable)

        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline.ask(
            question = "How many customers are from the US?",
            descriptor = descriptor(), password = null, llmClient = llmClient,
        )

        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))
        val resultSet = pipeline.execute(result.sql, descriptor(), password = null)
        assertTrue("expected at least one row back from a real query execution", resultSet.rows.isNotEmpty())
        dbFile.delete()
    }

    /** Proves the file-upload feature end to end: a CSV loaded via [DuckDbFileLoader], then a real local model answers a question against it through `ask()`/`execute()`. */
    @Test
    fun `ask answers a question against a real uploaded CSV file, through the full pipeline`() = runTest(timeout = 90.seconds) {
        assumeTrue("Ollama is not running locally with $MODEL pulled - skipping the live e2e test", ollamaAvailable)

        val uploadDbFile = File.createTempFile("asksql-duckdb-upload-e2e", ".duckdb")
        uploadDbFile.delete()
        val csvFile = File.createTempFile("asksql-upload-source", ".csv")
        csvFile.writeText("id,name,country\n1,Ava,US\n2,Ben,UK\n3,Cy,US\n")

        val driver = DriverProvisioner.duckDbDriver()
        driver.connect("jdbc:duckdb:${uploadDbFile.path}", Properties())!!.use { connection ->
            DuckDbFileLoader.loadFile(connection, csvFile.path, tableNameHint = "customers")
        }

        val uploadDescriptor = ConnectionDescriptor(
            id = "duckdb-upload-e2e", name = "upload-e2e", engine = EngineKind.DUCKDB, scope = ConnectionScope.PROJECT,
            filePath = uploadDbFile.path,
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline.ask(
            question = "How many customers are from the US?",
            descriptor = uploadDescriptor, password = null, llmClient = llmClient,
        )

        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))
        val resultSet = pipeline.execute(result.sql, uploadDescriptor, password = null)
        assertTrue("expected at least one row back from a real query against the uploaded file's data", resultSet.rows.isNotEmpty())

        uploadDbFile.delete()
        csvFile.delete()
    }

    /** Two separately-loaded files must be joinable, not just individually queryable, through the full ask()/execute() pipeline. */
    @Test
    fun `ask answers a cross-file question joining two separately-loaded CSVs`() = runTest(timeout = 90.seconds) {
        assumeTrue("Ollama is not running locally with $MODEL pulled - skipping the live e2e test", ollamaAvailable)

        val multiFileDbFile = File.createTempFile("asksql-duckdb-crossfile-e2e", ".duckdb")
        multiFileDbFile.delete()
        val customersCsv = File.createTempFile("asksql-crossfile-customers", ".csv")
        customersCsv.writeText("id,name\n1,Ava\n2,Ben\n")
        val ordersCsv = File.createTempFile("asksql-crossfile-orders", ".csv")
        ordersCsv.writeText("id,customer_id,total\n100,1,50.00\n101,1,25.00\n102,2,10.00\n")

        val driver = DriverProvisioner.duckDbDriver()
        driver.connect("jdbc:duckdb:${multiFileDbFile.path}", Properties())!!.use { connection ->
            DuckDbFileLoader.loadFile(connection, customersCsv.path, tableNameHint = "customers")
            DuckDbFileLoader.loadFile(connection, ordersCsv.path, tableNameHint = "orders")
        }

        val multiFileDescriptor = ConnectionDescriptor(
            id = "duckdb-crossfile-e2e", name = "crossfile-e2e", engine = EngineKind.DUCKDB, scope = ConnectionScope.PROJECT,
            filePath = multiFileDbFile.path,
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline.ask(
            question = "How many orders does each customer have? Show the customer's name.",
            descriptor = multiFileDescriptor, password = null, llmClient = llmClient,
        )

        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))
        assertTrue("expected the generated SQL to reference both loaded tables, got: ${result.sql}", result.sql.contains("customers", ignoreCase = true) && result.sql.contains("orders", ignoreCase = true))
        val resultSet = pipeline.execute(result.sql, multiFileDescriptor, password = null)
        assertTrue("expected at least one row back joining the two loaded files", resultSet.rows.isNotEmpty())

        multiFileDbFile.delete()
        customersCsv.delete()
        ordersCsv.delete()
    }
}
