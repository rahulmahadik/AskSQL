package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.util.Properties

/** Proves [EnginePipeline]'s core invariant (guard runs before every execution, no exceptions) end to end against a real, file-backed SQLite connection. */
class EnginePipelineTest {

    private fun seedDb(): File {
        val file = File.createTempFile("asksql-pipeline-test", ".sqlite")
        file.deleteOnExit()
        org.sqlite.JDBC().connect("jdbc:sqlite:${file.path}", Properties())!!.use { seed ->
            seed.createStatement().use { st ->
                st.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
                st.execute("INSERT INTO customers VALUES (1, 'Ava'), (2, 'Ben')")
            }
        }
        return file
    }

    private fun pipeline(): Pair<EnginePipeline, InMemoryHistoryStore> {
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val history = InMemoryHistoryStore()
        return EnginePipeline(registry, history) to history
    }

    private fun pipelineWithRegistry(): Pair<EnginePipeline, ConnectionRegistry> {
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        return EnginePipeline(registry) to registry
    }

    private fun descriptor(dbFile: File) = ConnectionDescriptor(
        id = "pipeline-test", name = "pipeline-test", engine = EngineKind.SQLITE, scope = ConnectionScope.PROJECT,
        filePath = dbFile.path,
    )

    /** A connection edited to point at a different database (same id) must not keep serving the OLD target's schema for up to 300s - see AskSqlEngineService/ConnectionsConfigurable's invalidateCatalogCache() wiring. */
    @Test
    fun `invalidateCatalogCache drops the stale schema after a connection's target changes`() = runTest {
        val dbFileA = seedDb() // has "customers"
        val dbFileB = File.createTempFile("asksql-pipeline-test-b", ".sqlite")
        dbFileB.delete()
        org.sqlite.JDBC().connect("jdbc:sqlite:${dbFileB.path}", Properties())!!.use { seed ->
            seed.createStatement().use { st -> st.execute("CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL)") }
        }

        val (pipeline, registry) = pipelineWithRegistry()
        val descriptorA = ConnectionDescriptor(id = "same-id", name = "t", engine = EngineKind.SQLITE, scope = ConnectionScope.PROJECT, filePath = dbFileA.path)
        val catalogA = pipeline.catalog(descriptorA, password = null)
        assertTrue(catalogA.tables.any { it.name == "customers" })

        // Same id, now pointing at a different file; mirrors editing a connection's target in settings.
        val descriptorB = descriptorA.copy(filePath = dbFileB.path)
        val stillCached = pipeline.catalog(descriptorB, password = null)
        assertTrue("expected the stale cached catalog before invalidation (still 'customers')", stillCached.tables.any { it.name == "customers" })

        // Both caches must be dropped together; the pipeline's own catalog
        // cache AND the underlying JDBC connection ConnectionRegistry holds
        // (still bound to file A's connection otherwise), matching exactly
        // what ConnectionsConfigurable.apply() does.
        pipeline.invalidateCatalogCache()
        registry.invalidate("same-id")
        val fresh = pipeline.catalog(descriptorB, password = null)
        assertTrue("expected the fresh catalog after invalidation ('products')", fresh.tables.any { it.name == "products" })

        dbFileA.delete()
        dbFileB.delete()
    }

    @Test
    fun `execute blocks a stacked-query write attempt and never runs it`() = runTest {
        val dbFile = seedDb()
        val (pipeline, history) = pipeline()
        val descriptor = descriptor(dbFile)

        var thrownCode: AskSqlErrorCode? = null
        try {
            pipeline.execute("SELECT 1; DROP TABLE customers", descriptor, password = null, question = "malicious")
            fail("expected the guard to block a stacked-query write attempt")
        } catch (e: AskSqlException) {
            thrownCode = e.code
        }
        assertEquals(AskSqlErrorCode.GUARD_BLOCKED, thrownCode)

        // The table must genuinely still exist and be untouched; the guard
        // ran BEFORE any statement reached the database, not just in theory.
        val result = pipeline.execute("SELECT COUNT(*) AS n FROM customers", descriptor, password = null)
        assertEquals(1, result.rows.size)

        val blockedEntry = history.recent().first { it.question == "malicious" }
        assertEquals(HistoryStatus.BLOCKED, blockedEntry.status)
        dbFile.delete()
    }

    @Test
    fun `execute runs a legitimate SELECT and records it in history`() = runTest {
        val dbFile = seedDb()
        val (pipeline, history) = pipeline()
        val descriptor = descriptor(dbFile)

        val result = pipeline.execute("SELECT name FROM customers ORDER BY id", descriptor, password = null, question = "list customers")
        assertEquals(listOf("Ava", "Ben"), result.rows.map { (it.first() as com.rahulmahadik.asksql.ide.model.CellValue.Text).value })

        val entry = history.recent().first { it.question == "list customers" }
        assertEquals(HistoryStatus.OK, entry.status)
        assertEquals(2, entry.rowCount)
        dbFile.delete()
    }

    @Test
    fun `execute re-guards SQL from scratch even if the caller claims it was already approved`() = runTest {
        // A statement that's benign in isolation but would be blocked outright
        // if generated fresh; proves execute() doesn't trust its caller and
        // re-runs the guard on every single call, per its own documented invariant.
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)

        var thrownCode: AskSqlErrorCode? = null
        try {
            pipeline.execute("DELETE FROM customers", descriptor, password = null)
            fail("expected the guard to block a DELETE statement")
        } catch (e: AskSqlException) {
            thrownCode = e.code
        }
        assertEquals(AskSqlErrorCode.GUARD_BLOCKED, thrownCode)
        dbFile.delete()
    }

    /** Throws a real CancellationException from chat() - deterministic, unlike simulating an actual cancelled coroutine's own completion timing/exception-aggregation semantics. */
    private class CancellingLlmClient : com.rahulmahadik.asksql.ide.llm.LlmClient {
        override suspend fun chat(system: String, userPrompt: String, onToken: com.rahulmahadik.asksql.ide.llm.TokenListener?): com.rahulmahadik.asksql.ide.llm.LlmResult {
            throw kotlinx.coroutines.CancellationException("simulated user cancel")
        }
        override suspend fun listModels(): List<String> = emptyList()
    }

    /** A cancellation raised mid-chat() (e.g. the user closing the tool window) must propagate as-is, not get misreported as an AskSqlException(LLM_UNAVAILABLE). */
    @Test
    fun `ask propagates a CancellationException raised mid-chat rather than misreporting it as an LLM failure`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)

        var thrown: Throwable? = null
        try {
            pipeline.ask(question = "how many customers", descriptor = descriptor, password = null, llmClient = CancellingLlmClient())
        } catch (e: Throwable) {
            thrown = e
        }

        assertTrue("expected the real CancellationException to propagate unwrapped, got: $thrown", thrown is kotlinx.coroutines.CancellationException)
        dbFile.delete()
    }

    /** "show tables" is not a SELECT, so the model refuses; these must be recognised so the catalog-view repair fires. */
    @Test
    fun `structure questions are recognised so the catalog-view repair can fire`() {
        listOf(
            "show tables",
            "can you show me list tables in db",
            "list the tables in this database",
            "what tables are in this database?",
            "which columns does customers have",
            "show me all views",
            "describe the columns",
            "how many tables are in the database",
            "give me the list of views",
            "tell me the schema",
            "what is the database structure",
            "which tables exist",
            "do we have any views",
        ).forEach { assertTrue("should be treated as a structure question: $it", EnginePipeline.isMetadataQuestion(it)) }

        listOf(
            "how many customers are there",
            "show 10 rows from customers",
            "total revenue last month",
        ).forEach { assertTrue("should NOT be a structure question: $it", !EnginePipeline.isMetadataQuestion(it)) }
    }

    @Test
    fun `each engine gets a read-only catalog query it can actually run`() {
        assertTrue(EnginePipeline.catalogQueryHint(EngineKind.SQLITE).contains("sqlite_master"))
        assertTrue(EnginePipeline.catalogQueryHint(EngineKind.MYSQL).contains("DATABASE()"))
        assertTrue(EnginePipeline.catalogQueryHint(EngineKind.ORACLE).contains("all_tables"))
        assertTrue(EnginePipeline.catalogQueryHint(EngineKind.POSTGRES).contains("information_schema.tables"))
        // Every hint must be a plain SELECT; SHOW/DESCRIBE would be blocked by the guard.
        EngineKind.entries.forEach {
            assertTrue("not a SELECT for $it", EnginePipeline.catalogQueryHint(it).trimStart().startsWith("SELECT", ignoreCase = true))
        }
    }

    private class FixedResponseLlmClient(private val sqlFence: String) : com.rahulmahadik.asksql.ide.llm.LlmClient {
        override suspend fun chat(system: String, userPrompt: String, onToken: com.rahulmahadik.asksql.ide.llm.TokenListener?) =
            com.rahulmahadik.asksql.ide.llm.LlmResult(sqlFence, com.rahulmahadik.asksql.ide.llm.LlmUsage())
        override suspend fun listModels(): List<String> = emptyList()
    }

    /** Throws AskSqlException(LLM_CONTEXT_OVERFLOW) on its first call, then succeeds - simulates a small-context local model rejecting the initial (larger) schema. */
    private class ContextOverflowThenSuccessLlmClient(private val sqlFence: String) : com.rahulmahadik.asksql.ide.llm.LlmClient {
        var callCount = 0
            private set
        override suspend fun chat(system: String, userPrompt: String, onToken: com.rahulmahadik.asksql.ide.llm.TokenListener?): com.rahulmahadik.asksql.ide.llm.LlmResult {
            callCount++
            if (callCount == 1) {
                throw AskSqlException(AskSqlErrorCode.LLM_CONTEXT_OVERFLOW, detail = "HTTP 400: maximum context length exceeded")
            }
            return com.rahulmahadik.asksql.ide.llm.LlmResult(sqlFence, com.rahulmahadik.asksql.ide.llm.LlmUsage())
        }
        override suspend fun listModels(): List<String> = emptyList()
    }

    /** Returns each response in order, one per call; simulates a model correcting itself on a repair retry. */
    private class SequentialResponseLlmClient(private val responses: List<String>) : com.rahulmahadik.asksql.ide.llm.LlmClient {
        var callCount = 0
            private set
        override suspend fun chat(system: String, userPrompt: String, onToken: com.rahulmahadik.asksql.ide.llm.TokenListener?): com.rahulmahadik.asksql.ide.llm.LlmResult {
            val response = responses[minOf(callCount, responses.size - 1)]
            callCount++
            return com.rahulmahadik.asksql.ide.llm.LlmResult(response, com.rahulmahadik.asksql.ide.llm.LlmUsage())
        }
        override suspend fun listModels(): List<String> = emptyList()
    }

    /** A model refusing "show appointmnts" (typo of "customers") over a misspelling must get one repair nudge toward the real table name, and disclose the correction, rather than a flat refusal. */
    @Test
    fun `ask corrects a misspelled table name in the question via one repair attempt, with the model disclosing it`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = SequentialResponseLlmClient(
            listOf(
                "IMPOSSIBLE: There is no \"custamers\" table in the schema provided.",
                "```sql\nSELECT * FROM customers\n```\nUsed \"customers\" since an exact match for \"custamers\" wasn't found.",
            ),
        )

        val result = pipeline.ask(question = "show custamers", descriptor = descriptor, password = null, llmClient = llm)
        assertEquals(2, llm.callCount)
        assertTrue(result.sql.contains("customers", ignoreCase = true))
        dbFile.delete()
    }

    /** A genuinely nonexistent table (nothing close in the schema) must still fail cleanly - the fuzzy-repair nudge must not fire when there's no plausible correction. */
    @Test
    fun `ask still reports cannot-answer for a table that has no close match in the schema`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = FixedResponseLlmClient("IMPOSSIBLE: There is no \"invoices\" table in the schema provided.")

        val error = try {
            pipeline.ask(question = "show invoices", descriptor = descriptor, password = null, llmClient = llm)
            null
        } catch (e: AskSqlException) {
            e
        }
        assertEquals(AskSqlErrorCode.LLM_CANNOT_ANSWER, error?.code)
        dbFile.delete()
    }

    /** A context-overflow error must trigger exactly one shrink-and-retry (not a hard failure), and that retry must not count against the repair budget - ported from core's `ask()` (packages/core/src/engine.ts, read-only reference). */
    @Test
    fun `ask shrinks the schema and retries once on a context-overflow error, without consuming a repair attempt`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = ContextOverflowThenSuccessLlmClient("```sql\nSELECT * FROM customers\n```")

        val result = pipeline.ask(question = "how many customers", descriptor = descriptor, password = null, llmClient = llm)

        assertEquals(2, llm.callCount)
        assertEquals(0, result.repairs)
        dbFile.delete()
    }

    /** explain() must guard its (caller-supplied) SQL before ever sending it to the model - otherwise it's a free-text channel to the model on the host's API key, bypassing the read-only floor entirely. */
    @Test
    fun `explain rejects a non-read-only statement without ever calling the model`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = FixedResponseLlmClient("this SQL deletes everything, obviously")

        val error = try {
            pipeline.explain("DELETE FROM customers", descriptor, password = null, llmClient = llm)
            null
        } catch (e: AskSqlException) {
            e
        }
        assertEquals(AskSqlErrorCode.GUARD_BLOCKED, error?.code)
        dbFile.delete()
    }

    /** A legitimate read-only SELECT must still explain normally under the guard-first check. */
    @Test
    fun `explain succeeds for an ordinary read-only SELECT`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = FixedResponseLlmClient("This lists every customer.")

        val explanation = pipeline.explain("SELECT * FROM customers", descriptor, password = null, llmClient = llm)
        assertEquals("This lists every customer.", explanation)
        dbFile.delete()
    }

    /** suggestFix must enforce the same hallucination floor ask() does - a "fix" naming a table that doesn't exist would just fail again once the user re-approves and runs it. */
    @Test
    fun `suggestFix returns null when the repaired SQL references a nonexistent table`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = FixedResponseLlmClient("```sql\nSELECT * FROM ghost_table\n```")

        val fix = pipeline.suggestFix(
            failedSql = "SELECT * FROM customer", descriptor = descriptor, password = null,
            question = "list customers", errorDetail = "no such table: customer", llmClient = llm,
        )
        assertEquals(null, fix)
        dbFile.delete()
    }

    /** suggestFix must enforce the same hallucination floor ask() does - a "fix" referencing a nonexistent column would just fail again once the user re-approves and runs it. */
    @Test
    fun `suggestFix returns null when the repaired SQL references a nonexistent column`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = FixedResponseLlmClient("```sql\nSELECT ghost_column FROM customers\n```")

        val fix = pipeline.suggestFix(
            failedSql = "SELECT ghost_column FROM customer", descriptor = descriptor, password = null,
            question = "list customers", errorDetail = "no such column", llmClient = llm,
        )
        assertEquals(null, fix)
        dbFile.delete()
    }

    /** A model dodging a question with a literal SELECT ("SELECT 'IMPOSSIBLE: ...'") must surface as a clean error, not run as if it were a real result. */
    @Test
    fun `ask rejects a literal-only SELECT that dodges the question with an IMPOSSIBLE string`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = FixedResponseLlmClient("```sql\nSELECT 'IMPOSSIBLE: This question cannot be answered from the provided schema.'\nLIMIT 1000\n```")

        val error = try {
            pipeline.ask(question = "how are you", descriptor = descriptor, password = null, llmClient = llm)
            null
        } catch (e: AskSqlException) {
            e
        }
        assertEquals(AskSqlErrorCode.LLM_CANNOT_ANSWER, error?.code)
        dbFile.delete()
    }

    /** A noncompliant model rambling for paragraphs after "IMPOSSIBLE:" must not dump that whole rant into the chat as a red error. */
    @Test
    fun `ask surfaces only a short, clean reason when the model rambles after the IMPOSSIBLE sentinel`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val rambling = "IMPOSSIBLE: Client ID is NOT NULL in the clients table, so I cannot fetch client data\n" +
            "To provide row-level answers, I need to query all related tables\n" +
            "Solution: To query related tables, you need to join other tables\n" +
            "```sql\nToo see related information```sql"
        val llm = FixedResponseLlmClient(rambling)

        val error = try {
            pipeline.ask(question = "show me clients", descriptor = descriptor, password = null, llmClient = llm)
            null
        } catch (e: AskSqlException) {
            e
        }
        assertEquals(AskSqlErrorCode.LLM_CANNOT_ANSWER, error?.code)
        assertEquals("Client ID is NOT NULL in the clients table, so I cannot fetch client data", error?.userMessage)
        dbFile.delete()
    }

    /** A model answering small talk ("how are you") with a hardcoded string dressed up as a row must not be executed and shown as if it were real data. */
    @Test
    fun `ask rejects a literal-string SELECT that answers small talk instead of the connected data`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = FixedResponseLlmClient(
            "```sql\nSELECT \n  'AskSQL is operational and ready to assist with queries. How can I help you today?' AS status\nLIMIT 1\n```",
        )

        val error = try {
            pipeline.ask(question = "how are you and how you work", descriptor = descriptor, password = null, llmClient = llm)
            null
        } catch (e: AskSqlException) {
            e
        }
        assertEquals(AskSqlErrorCode.LLM_CANNOT_ANSWER, error?.code)
        dbFile.delete()
    }

    /** A genuine zero-table meta query (SELECT version()) is a real, useful answer and must NOT be rejected by the literal-answer dodge check. */
    @Test
    fun `ask still allows a genuine zero-table function call like SELECT version()`() = runTest {
        val dbFile = seedDb()
        val (pipeline, _) = pipeline()
        val descriptor = descriptor(dbFile)
        val llm = FixedResponseLlmClient("```sql\nSELECT sqlite_version() AS version\nLIMIT 1\n```")

        val result = pipeline.ask(question = "what version of the database engine is this", descriptor = descriptor, password = null, llmClient = llm)
        assertTrue(result.sql.contains("sqlite_version", ignoreCase = true))
        dbFile.delete()
    }
}
