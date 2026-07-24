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
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.experimental.categories.Category
import java.io.File
import java.net.Socket
import java.util.Properties
import kotlin.time.Duration.Companion.minutes

/**
 * Throwaway: re-runs only the 8 questions that failed in ComplexJoinAccuracyEvalTest against
 * an untried local model, one question at a time, to see whether a different model answers them.
 */
@Category(IntegrationTest::class)
class FailedQuestionsRetestTest {

    companion object {
        private const val OLLAMA_BASE_URL = "http://localhost:11434/v1"
        private val REPORT_DIR = System.getProperty("java.io.tmpdir")
    }

    data class Case(val question: String, val truthSql: String)
    enum class Verdict { CORRECT, WRONG_RESULT, INVALID_SQL, IMPOSSIBLE, GUARD_BLOCKED, HALLUCINATION, OTHER_ERROR }

    private fun llm(model: String) = LlmClients.forConfig(ProviderConfig(provider = ProviderKind.OLLAMA, model = model, baseUrl = OLLAMA_BASE_URL))

    private fun cells(rs: AskSqlResultSet): List<List<String>> = rs.rows.map { row ->
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

    private fun cellMatches(truth: String, model: String): Boolean {
        if (truth == model) return true
        val t = truth.toDoubleOrNull()
        val m = model.toDoubleOrNull()
        if (t != null && m != null) return Math.abs(t - m) < 1e-6
        if (t == null && truth.length >= 3) return model.contains(truth)
        if (t != null && m == null) return Regex("(?<![\\d.])" + Regex.escape(truth.removeSuffix(".0")) + "(?![\\d])").containsMatchIn(model)
        return false
    }

    private fun resultMatches(truth: List<List<String>>, model: List<List<String>>): Boolean {
        if (truth.size != model.size) return false
        val used = BooleanArray(model.size)
        for (tRow in truth) {
            val idx = model.indices.firstOrNull { i -> !used[i] && tRow.all { tc -> model[i].any { mc -> cellMatches(tc, mc) } } } ?: return false
            used[idx] = true
        }
        return true
    }

    private fun classify(e: AskSqlException): Pair<Verdict, String> {
        val v = when {
            e.code == AskSqlErrorCode.GUARD_BLOCKED -> Verdict.GUARD_BLOCKED
            e.code == AskSqlErrorCode.DB_QUERY_ERROR -> Verdict.INVALID_SQL
            e.code == AskSqlErrorCode.LLM_REFUSAL -> Verdict.IMPOSSIBLE
            e.code == AskSqlErrorCode.LLM_CANNOT_ANSWER -> Verdict.IMPOSSIBLE
            e.code == AskSqlErrorCode.LLM_BAD_OUTPUT && e.userMessage.contains("doesn't exist") -> Verdict.HALLUCINATION
            e.code == AskSqlErrorCode.LLM_BAD_OUTPUT -> Verdict.IMPOSSIBLE
            else -> Verdict.OTHER_ERROR
        }
        return v to "${e.code}: ${e.userMessage}"
    }

    private suspend fun runOne(label: String, model: String, pipeline: EnginePipeline, descriptor: ConnectionDescriptor, case: Case, report: StringBuilder) {
        val truth = cells(pipeline.execute(case.truthSql, descriptor, password = null))
        var modelSql = ""
        var verdict: Verdict
        var note = ""
        var modelRows: List<List<String>> = emptyList()
        try {
            val ask = pipeline.ask(question = case.question, descriptor = descriptor, password = null, llmClient = llm(model))
            modelSql = ask.sql
            val rs = pipeline.execute(ask.sql, descriptor, password = null, question = case.question)
            modelRows = cells(rs)
            verdict = if (resultMatches(truth, modelRows)) Verdict.CORRECT else Verdict.WRONG_RESULT
        } catch (e: AskSqlException) {
            val (v, n) = classify(e)
            verdict = v
            note = n
        }
        report.appendLine("### [$label / $model] $verdict")
        report.appendLine("Q: ${case.question}")
        report.appendLine("MODEL_SQL: ${modelSql.replace('\n', ' ')}")
        if (note.isNotEmpty()) report.appendLine("ERROR: $note")
        report.appendLine("TRUTH: $truth")
        report.appendLine("MODEL: $modelRows")
        report.appendLine()
        println(report.toString().substringAfterLast("### ["))
    }

    @Test
    fun `retest the failed mysql and postgres questions with untried local models`() = runTest(timeout = 60.minutes) {
        val mysqlUp = runCatching { Socket("localhost", 53306).use { true } }.getOrDefault(false)
        val pgUp = runCatching { Socket("localhost", 55432).use { true } }.getOrDefault(false)
        assumeTrue("Neither MySQL nor Postgres reachable", mysqlUp || pgUp)

        val models = listOf("qwen2.5-coder:14b-instruct", "qwen2.5:14b-instruct")
        val report = StringBuilder()
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)

        if (mysqlUp) {
            val mysqlDescriptor = ConnectionDescriptor(
                id = "mysql-retest", name = "retest", engine = EngineKind.MYSQL, scope = ConnectionScope.PROJECT,
                host = "localhost", port = 53306, database = "asksql_demo", user = "root",
            )
            val mysqlCase = Case(
                "How many distinct products has the customer named Alice Johnson ever ordered?",
                "SELECT COUNT(DISTINCT oi.product_name) FROM customers c JOIN orders o ON o.customer_id=c.id JOIN order_items oi ON oi.order_id=o.id WHERE c.name='Alice Johnson'",
            )
            for (model in models) runOne("mysql", model, pipeline, mysqlDescriptor, mysqlCase, report)
        }

        if (pgUp) {
            val pgDescriptor = ConnectionDescriptor(
                id = "pg-retest", name = "retest", engine = EngineKind.POSTGRES, scope = ConnectionScope.PROJECT,
                host = "localhost", port = 55432, database = "asksql_demo", user = "asksql",
            )
            val pgCases = listOf(
                Case(
                    "For each product, show the product name and its total revenue in cents computed as quantity times unit price across all order items.",
                    "SELECT product_name, SUM(quantity*unit_price_cents) FROM order_items GROUP BY product_name",
                ),
                Case(
                    "Which product appears in the greatest number of distinct orders? Show only that product's name.",
                    "SELECT product_name FROM order_items GROUP BY product_name ORDER BY COUNT(DISTINCT order_id) DESC LIMIT 1",
                ),
                Case(
                    "For each product, show the product name and the number of distinct customers who have bought it.",
                    "SELECT oi.product_name, COUNT(DISTINCT o.customer_id) FROM order_items oi JOIN orders o ON o.id=oi.order_id GROUP BY oi.product_name",
                ),
            )
            for (model in models) for (case in pgCases) runOne("postgres", model, pipeline, pgDescriptor, case, report)
        }

        File(REPORT_DIR).mkdirs()
        File("$REPORT_DIR/retest-mysql-postgres.txt").writeText(report.toString())
    }

    @Test
    fun `retest the failed duckdb question with untried local models`() = runTest(timeout = 60.minutes) {
        assumeTrue("Ollama not reachable", runCatching { Socket("localhost", 11434).use { true } }.getOrDefault(false))
        val models = listOf("qwen2.5-coder:14b-instruct", "qwen2.5:14b-instruct")
        val report = StringBuilder()
        val dbFile = File.createTempFile("asksql-retest", ".duckdb")
        dbFile.delete()
        DriverProvisioner.duckDbDriver().connect("jdbc:duckdb:${dbFile.path}", Properties())!!.use { conn ->
            conn.createStatement().use { st ->
                st.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL)")
                st.execute("INSERT INTO customers VALUES (1,'Ava','US'),(2,'Ben','UK'),(3,'Cy','US'),(4,'Dee','DE'),(5,'Eli','US')")
                st.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL)")
                st.execute("INSERT INTO orders VALUES (1,1,'completed'),(2,1,'completed'),(3,2,'pending'),(4,3,'completed'),(5,4,'completed'),(6,1,'pending')")
                st.execute("CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, product TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL)")
                st.execute(
                    "INSERT INTO order_items VALUES (1,1,'Widget',2,1000),(2,1,'Gadget',1,500),(3,2,'Widget',1,1000),(4,3,'Gizmo',3,1200)," +
                        "(5,4,'Gadget',2,500),(6,4,'Gizmo',1,1200),(7,5,'Widget',5,1000),(8,6,'Doohickey',1,9900)",
                )
            }
        }
        val descriptor = ConnectionDescriptor(
            id = "duckdb-retest", name = "retest", engine = EngineKind.DUCKDB, scope = ConnectionScope.PROJECT,
            filePath = dbFile.path,
        )
        val spend = "SELECT c.id, c.name, SUM(oi.quantity*oi.unit_price_cents) total FROM customers c JOIN orders o ON o.customer_id=c.id JOIN order_items oi ON oi.order_id=o.id GROUP BY c.id, c.name"
        val case = Case(
            "List the names of customers whose total spend in cents is greater than the average per-customer total spend, considering only customers with orders.",
            "SELECT name FROM ($spend) t WHERE total > (SELECT AVG(total) FROM ($spend) u)",
        )
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        for (model in models) runOne("duckdb", model, pipeline, descriptor, case, report)

        File(REPORT_DIR).mkdirs()
        File("$REPORT_DIR/retest-duckdb.txt").writeText(report.toString())
        dbFile.delete()
    }

    @Test
    fun `retest the failed mongodb questions with untried local models`() = runTest(timeout = 60.minutes) {
        assumeTrue("MongoDB not reachable", runCatching { Socket("localhost", 57017).use { true } }.getOrDefault(false))
        val models = listOf("qwen2.5-coder:14b-instruct", "qwen2.5:14b-instruct")
        val report = StringBuilder()
        val descriptor = ConnectionDescriptor(
            id = "mongo-retest", name = "retest", engine = EngineKind.MONGODB, scope = ConnectionScope.PROJECT,
            database = "asksql_demo", connectionString = "mongodb://localhost:57017/asksql_demo",
        )
        val pipeline = MongoEnginePipeline(MongoClientRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))

        val lookupOrders = "{\"\$lookup\":{\"from\":\"orders\",\"localField\":\"_id\",\"foreignField\":\"customerId\",\"as\":\"o\"}}"
        data class MongoCase(val question: String, val truthCollection: String, val truthPipeline: String)
        val mongoCases = listOf(
            MongoCase(
                "List the names of customers who have never placed an order.",
                "customers",
                "[$lookupOrders,{\"\$project\":{\"_id\":0,\"name\":1,\"n\":{\"\$size\":\"\$o\"}}},{\"\$match\":{\"n\":0}},{\"\$project\":{\"_id\":0,\"name\":1}}]",
            ),
            MongoCase(
                "Show each customer's name and how many orders they have placed, including customers with zero orders.",
                "customers",
                "[$lookupOrders,{\"\$project\":{\"_id\":0,\"name\":1,\"n\":{\"\$size\":\"\$o\"}}}]",
            ),
            MongoCase(
                "What is the average price of products tagged hardware?",
                "products",
                "[{\"\$match\":{\"tags\":\"hardware\"}},{\"\$group\":{\"_id\":null,\"avg\":{\"\$avg\":\"\$price\"}}}]",
            ),
        )

        for (model in models) {
            for (mc in mongoCases) {
                val llmClient = llm(model)
                val truth = cells(pipeline.execute(mc.truthPipeline, mc.truthCollection, descriptor, password = null))
                var modelQuery = ""
                var verdict: Verdict
                var note = ""
                var modelRows: List<List<String>> = emptyList()
                try {
                    val ask = pipeline.ask(question = mc.question, descriptor = descriptor, password = null, llmClient = llmClient)
                    modelQuery = "collection=${ask.collection} pipeline=${ask.pipelineJson}"
                    val rs = pipeline.execute(ask.pipelineJson, ask.collection, descriptor, password = null, question = mc.question)
                    modelRows = cells(rs)
                    verdict = if (resultMatches(truth, modelRows)) Verdict.CORRECT else Verdict.WRONG_RESULT
                } catch (e: AskSqlException) {
                    val (v, n) = classify(e)
                    verdict = v
                    note = n
                }
                report.appendLine("### [mongodb / $model] $verdict")
                report.appendLine("Q: ${mc.question}")
                report.appendLine("MODEL_QUERY: ${modelQuery.replace('\n', ' ')}")
                if (note.isNotEmpty()) report.appendLine("ERROR: $note")
                report.appendLine("TRUTH: $truth")
                report.appendLine("MODEL: $modelRows")
                report.appendLine()
            }
        }
        File(REPORT_DIR).mkdirs()
        File("$REPORT_DIR/retest-mongodb.txt").writeText(report.toString())
        println(report)
    }
}
