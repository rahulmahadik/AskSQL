package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.DriverProvisioner
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.llm.LlmClients
import com.rahulmahadik.asksql.ide.llm.ProviderConfig
import com.rahulmahadik.asksql.ide.llm.ProviderKind
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.GuardPolicy
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.experimental.categories.Category
import java.io.File
import java.net.Socket
import java.util.Properties
import kotlin.time.Duration.Companion.minutes

/**
 * Live edge-case sweep against real local databases and Ollama. Hard plugin invariants (small talk
 * rejected, row cap enforced, no crash) are asserted; model-dependent accuracy on messy phrasings is only tallied.
 */
@Category(IntegrationTest::class)
class EdgeCaseAccuracyEvalTest {

    companion object {
        /** Overridable so the eval runs on whatever model a machine has. */
        private val MODEL: String = System.getenv("ASKSQL_OLLAMA_MODEL")?.substringBefore(",")?.trim()?.ifEmpty { null } ?: "qwen2.5-coder:7b"
        private const val OLLAMA_BASE_URL = "http://localhost:11434/v1"
        private val REPORT_DIR = System.getProperty("java.io.tmpdir")
    }

    /**
     * LEGIT: check against ground truth. REJECT: the pipeline MUST decline (small talk, off-topic).
     * SOFT_REJECT: ideally declined, but answering with adjacent columns is a model choice, not a
     * plugin defect (e.g. "home address" when only name/email exist), so it is tallied, not asserted.
     */
    enum class Kind { LEGIT, REJECT, SOFT_REJECT }
    enum class Verdict { CORRECT, WRONG_RESULT, REJECTED, INVALID_SQL, CRASH }

    /** [truthCells] holds substrings that must each appear somewhere in the result (LEGIT only). */
    data class Case(val label: String, val kind: Kind, val question: String, val truthCells: List<String> = emptyList())

    private fun llm() = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = MODEL, baseUrl = OLLAMA_BASE_URL))
    private fun sqlPipeline() = EnginePipeline(ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))

    private fun cells(rs: AskSqlResultSet): List<String> = rs.rows.flatMap { row ->
        row.map { c ->
            when (c) {
                is CellValue.Null -> "NULL"
                is CellValue.Text -> c.value
                is CellValue.Number -> c.value.toString()
                is CellValue.Boolean -> c.value.toString()
                is CellValue.ExactNumeric -> c.value
                is CellValue.Binary -> "BINARY"
            }
        }
    }

    private fun numeric(s: String): Double? = s.toDoubleOrNull()

    /** A truth cell matches if it appears verbatim, or numerically equals some result cell. */
    private fun truthPresent(truth: String, resultCells: List<String>): Boolean {
        if (resultCells.any { it.contains(truth, ignoreCase = true) }) return true
        val t = numeric(truth) ?: return false
        return resultCells.any { numeric(it)?.let { r -> Math.abs(r - t) < 1e-6 } == true }
    }

    // Shared customers/orders/order_items schema: customers Alice/Bob/Carol; orders 2500/1200/9900; items Widget/Gadget/Gizmo.
    private fun relationalCases() = listOf(
        Case("clean-count", Kind.LEGIT, "How many customers are there?", listOf("3")),
        Case("typo-table", Kind.LEGIT, "how many custommers are in the database?", listOf("3")),
        Case("bad-grammar", Kind.LEGIT, "how much customer is there in database", listOf("3")),
        Case("fragment", Kind.LEGIT, "customer count", listOf("3")),
        Case("agg-revenue", Kind.LEGIT, "what is the total value in cents of all orders combined?", listOf("13600")),
        Case("filter", Kind.LEGIT, "list the names of customers, one per row", listOf("Alice Johnson", "Bob Smith", "Carol White")),
        Case("join-typo", Kind.LEGIT, "show the naem of each customer and how many ordrs they placed", listOf("Alice Johnson")),
        Case("small-talk", Kind.REJECT, "how are you doing today?"),
        Case("greeting", Kind.REJECT, "hello there, what is your name?"),
        Case("off-topic", Kind.REJECT, "what is the capital of France?"),
        Case("impossible-column", Kind.SOFT_REJECT, "what is each customer's home street address?"),
    )

    private suspend fun runSuite(engineLabel: String, descriptor: ConnectionDescriptor, cases: List<Case>, report: StringBuilder): List<Pair<Case, Verdict>> {
        val pipeline = sqlPipeline()
        val results = mutableListOf<Pair<Case, Verdict>>()
        for (case in cases) {
            var sql = ""
            var note = ""
            val verdict = try {
                val ask = pipeline.ask(question = case.question, descriptor = descriptor, password = null, llmClient = llm())
                sql = ask.sql
                val rs = pipeline.execute(ask.sql, descriptor, password = null, question = case.question)
                val rc = cells(rs)
                when {
                    case.kind != Kind.LEGIT -> Verdict.WRONG_RESULT // a reject-kind case got answered
                    case.truthCells.all { truthPresent(it, rc) } -> Verdict.CORRECT
                    else -> Verdict.WRONG_RESULT
                }
            } catch (e: AskSqlException) {
                note = "${e.code}: ${e.userMessage}"
                when (e.code) {
                    AskSqlErrorCode.LLM_CANNOT_ANSWER, AskSqlErrorCode.LLM_REFUSAL -> Verdict.REJECTED
                    AskSqlErrorCode.LLM_BAD_OUTPUT -> Verdict.REJECTED
                    AskSqlErrorCode.DB_QUERY_ERROR -> Verdict.INVALID_SQL
                    else -> Verdict.CRASH
                }
            } catch (e: Exception) {
                note = "UNEXPECTED: ${e::class.simpleName}: ${e.message}"
                Verdict.CRASH
            }
            results += case to verdict
            report.appendLine("### [$engineLabel ${case.label}] kind=${case.kind} -> $verdict")
            report.appendLine("Q: ${case.question}")
            if (sql.isNotEmpty()) report.appendLine("SQL: ${sql.replace('\n', ' ')}")
            if (note.isNotEmpty()) report.appendLine("NOTE: $note")
            report.appendLine()
        }
        return results
    }

    /** Writes the report first (so results survive an assertion failure), then checks the hard invariants. */
    private fun reportAndAssert(engineLabel: String, results: List<Pair<Case, Verdict>>, report: StringBuilder) {
        val byVerdict = results.groupingBy { it.second }.eachCount()
        report.appendLine("== $engineLabel TALLY: ${byVerdict.entries.joinToString(" ") { "${it.key}=${it.value}" }}")
        File(REPORT_DIR).mkdirs()
        File("$REPORT_DIR/edge-$engineLabel.txt").writeText(report.toString())
        println(report)
        val crashes = results.filter { it.second == Verdict.CRASH }
        assertTrue("$engineLabel: pipeline crashed on: ${crashes.map { it.first.label }}", crashes.isEmpty())
        val leakedRejects = results.filter { it.first.kind == Kind.REJECT && it.second != Verdict.REJECTED }
        assertTrue("$engineLabel: these should have been declined but were answered: ${leakedRejects.map { it.first.label }}", leakedRejects.isEmpty())
    }

    private fun postgresDescriptor() = ConnectionDescriptor(
        id = "pg-edge", name = "edge", engine = EngineKind.POSTGRES, scope = ConnectionScope.PROJECT,
        host = "localhost", port = 55432, database = "asksql_demo", user = "asksql",
    )

    private fun mysqlDescriptor() = ConnectionDescriptor(
        id = "mysql-edge", name = "edge", engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
        host = "localhost", port = 53306, database = "asksql_demo", user = "root",
    )

    private fun reachable(port: Int) = runCatching { Socket("localhost", port).use { true } }.getOrDefault(false)

    @Test
    fun `postgres edge cases`() = runTest(timeout = 40.minutes) {
        assumeTrue("Postgres not reachable", reachable(55432))
        val report = StringBuilder()
        val results = runSuite("postgres", postgresDescriptor(), relationalCases(), report)
        reportAndAssert("postgres", results, report)
    }

    @Test
    fun `mysql edge cases`() = runTest(timeout = 40.minutes) {
        assumeTrue("MySQL not reachable", reachable(53306))
        val report = StringBuilder()
        val results = runSuite("mysql", mysqlDescriptor(), relationalCases(), report)
        reportAndAssert("mysql", results, report)
    }

    @Test
    fun `duckdb edge cases`() = runTest(timeout = 40.minutes) {
        assumeTrue("Ollama not reachable", reachable(11434))
        val dbFile = File.createTempFile("asksql-edge", ".duckdb"); dbFile.delete()
        DriverProvisioner.duckDbDriver().connect("jdbc:duckdb:${dbFile.path}", Properties())!!.use { conn ->
            conn.createStatement().use { st ->
                st.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
                st.execute("INSERT INTO customers VALUES (1,'Alice Johnson'),(2,'Bob Smith'),(3,'Carol White')")
                st.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_cents INTEGER, status TEXT)")
                st.execute("INSERT INTO orders VALUES (1,1,2500,'completed'),(2,1,1200,'pending'),(3,2,9900,'completed')")
            }
        }
        val descriptor = ConnectionDescriptor(
            id = "duckdb-edge", name = "edge", engine = EngineKind.DUCKDB, scope = ConnectionScope.PROJECT, filePath = dbFile.path,
        )
        val report = StringBuilder()
        val results = runSuite("duckdb", descriptor, relationalCases().filter { it.label != "join-typo" && it.label != "filter" }, report)
        reportAndAssert("duckdb", results, report)
        dbFile.delete()
    }

    /** Hard invariant: the row cap injected by the guard actually limits execution, whatever the model wrote. */
    @Test
    fun `postgres row cap is enforced regardless of the model`() = runTest(timeout = 10.minutes) {
        assumeTrue("Postgres not reachable", reachable(55432))
        val pipeline = EnginePipeline(
            ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)),
            policy = GuardPolicy(maxRows = 2),
        )
        val descriptor = postgresDescriptor()
        val ask = pipeline.ask(question = "list every order id", descriptor = descriptor, password = null, llmClient = llm())
        val rs = pipeline.execute(ask.sql, descriptor, password = null, maxRows = 2)
        assertTrue("expected at most 2 rows with maxRows=2, got ${rs.rows.size}", rs.rows.size <= 2)
    }

    // --- MongoDB ---

    private fun mongoDescriptor() = ConnectionDescriptor(
        id = "mongo-edge", name = "edge", engine = EngineKind.MONGODB, scope = ConnectionScope.PROJECT,
        database = "asksql_demo", connectionString = "mongodb://localhost:57017/asksql_demo",
    )

    @Test
    fun `mongodb edge cases`() = runTest(timeout = 40.minutes) {
        assumeTrue("MongoDB not reachable", reachable(57017))
        val pipeline = MongoEnginePipeline(MongoClientRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))
        val descriptor = mongoDescriptor()
        val cases = listOf(
            Case("clean-count", Kind.LEGIT, "How many customers are there?", listOf("3")),
            Case("typo", Kind.LEGIT, "how many custommers are there?", listOf("3")),
            Case("bad-grammar", Kind.LEGIT, "how much customer is there", listOf("3")),
            Case("agg", Kind.LEGIT, "what is the total of all order totals in cents?", listOf("13600")),
            Case("products", Kind.LEGIT, "what is the price of the product named Widget?", listOf("9.99")),
            Case("small-talk", Kind.REJECT, "how are you doing today?"),
            Case("off-topic", Kind.REJECT, "what is the capital of France?"),
            Case("impossible", Kind.SOFT_REJECT, "what is each customer's home street address?"),
        )
        val report = StringBuilder()
        val results = mutableListOf<Pair<Case, Verdict>>()
        for (case in cases) {
            var note = ""
            val verdict = try {
                val ask = pipeline.ask(question = case.question, descriptor = descriptor, password = null, llmClient = llm())
                val rs = pipeline.execute(ask.pipelineJson, ask.collection, descriptor, password = null, question = case.question)
                val rc = cells(rs)
                when {
                    case.kind != Kind.LEGIT -> Verdict.WRONG_RESULT
                    case.truthCells.all { truthPresent(it, rc) } -> Verdict.CORRECT
                    else -> Verdict.WRONG_RESULT
                }
            } catch (e: AskSqlException) {
                note = "${e.code}: ${e.userMessage}"
                when (e.code) {
                    AskSqlErrorCode.LLM_CANNOT_ANSWER, AskSqlErrorCode.LLM_REFUSAL, AskSqlErrorCode.LLM_BAD_OUTPUT -> Verdict.REJECTED
                    AskSqlErrorCode.DB_QUERY_ERROR, AskSqlErrorCode.GUARD_BLOCKED -> Verdict.INVALID_SQL
                    else -> Verdict.CRASH
                }
            } catch (e: Exception) {
                note = "UNEXPECTED: ${e::class.simpleName}: ${e.message}"
                Verdict.CRASH
            }
            results += case to verdict
            report.appendLine("### [mongodb ${case.label}] kind=${case.kind} -> $verdict")
            report.appendLine("Q: ${case.question}")
            if (note.isNotEmpty()) report.appendLine("NOTE: $note")
            report.appendLine()
        }
        reportAndAssert("mongodb", results, report)
    }
}
