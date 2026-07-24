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

/** A real, non-mocked run of [EnginePipeline.ask]/[EnginePipeline.execute] against a locally-running MySQL and Ollama; skips itself when either isn't reachable. */
@Category(IntegrationTest::class)
class MySqlEndToEndTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 53306
        private const val DB = "asksql_demo"
        private const val USER = "root"
        private const val MODEL = "qwen2.5-coder:7b"
        private const val OLLAMA_BASE_URL = "http://localhost:11434/v1"
    }

    private var mysqlAvailable = false

    @Before
    fun checkMysql() {
        mysqlAvailable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
    }

    @Test
    fun `ask produces a working SELECT against a real local MySQL and a real local model`() = runTest(timeout = 90.seconds) {
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping the live e2e test", mysqlAvailable)

        val descriptor = ConnectionDescriptor(
            id = "mysql-e2e", name = "e2e", engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
            host = HOST, port = PORT, database = DB, user = USER,
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline.ask(
            question = "How many customers are there in total?",
            descriptor = descriptor,
            password = null,
            llmClient = llmClient,
        )

        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))

        val resultSet = pipeline.execute(result.sql, descriptor, password = null)
        assertTrue("expected at least one row back from a real query execution", resultSet.rows.isNotEmpty())
    }

    private fun descriptor(id: String) = ConnectionDescriptor(
        id = id, name = id, engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
        host = HOST, port = PORT, database = DB, user = USER,
    )

    private fun pipeline() = EnginePipeline(ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))

    /** Real end-to-end proof that a zero-value DATETIME round-trips as text through the full pipeline (getString() returns it even though wasNull() reports true), not a misleading NULL. */
    @Test
    fun `execute reads a zero-value DATETIME as text, not a misleading NULL`() = runTest(timeout = 30.seconds) {
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping the live e2e test", mysqlAvailable)
        val descriptor = descriptor("mysql-e2e-zerodate")

        val resultSet = pipeline().execute("SELECT username, last_login FROM signups WHERE username = 'bob'", descriptor, password = null)
        assertTrue(resultSet.rows.isNotEmpty())
        val lastLogin = resultSet.rows.first()[1]
        assertTrue(
            "expected the zero-value DATETIME to read as Text (containing the zero-date text), not Null - got $lastLogin",
            lastLogin is com.rahulmahadik.asksql.ide.model.CellValue.Text && (lastLogin as com.rahulmahadik.asksql.ide.model.CellValue.Text).value.startsWith("0000-00-00"),
        )
    }

    /** Real end-to-end proof that a genuine NULL still reads as NULL, not as a zero-datetime string. */
    @Test
    fun `execute still reads a genuine NULL as Null`() = runTest(timeout = 30.seconds) {
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping the live e2e test", mysqlAvailable)
        val descriptor = descriptor("mysql-e2e-realnull")

        val resultSet = pipeline().execute("SELECT username, last_login FROM signups WHERE username = 'carol'", descriptor, password = null)
        assertTrue(resultSet.rows.isNotEmpty())
        assertTrue("expected a genuine NULL to still read as Null", resultSet.rows.first()[1] is com.rahulmahadik.asksql.ide.model.CellValue.Null)
    }

    /** Real end-to-end proof that a multi-bit BIT(n) column round-trips as text rather than silently collapsing to a boolean. */
    @Test
    fun `ask queries a BIT(n) flags column without collapsing it to a boolean`() = runTest(timeout = 90.seconds) {
        assumeTrue("MySQL is not reachable on localhost:$PORT - skipping the live e2e test", mysqlAvailable)
        val descriptor = descriptor("mysql-e2e-bitflags")
        val llmClient = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))

        val result = pipeline().ask(question = "What are the permission flags for the user named alice, in the user_permissions table?", descriptor = descriptor, password = null, llmClient = llmClient)
        assertTrue("expected a SELECT statement, got: ${result.sql}", result.sql.trim().startsWith("SELECT", ignoreCase = true))

        val resultSet = pipeline().execute(result.sql, descriptor, password = null)
        assertTrue("expected at least one row back from a real query against a BIT(n) column", resultSet.rows.isNotEmpty())
    }
}
