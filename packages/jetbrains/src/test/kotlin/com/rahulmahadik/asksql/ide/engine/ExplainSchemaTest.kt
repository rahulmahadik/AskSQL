package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.llm.LlmClient
import com.rahulmahadik.asksql.ide.llm.LlmResult
import com.rahulmahadik.asksql.ide.llm.LlmUsage
import com.rahulmahadik.asksql.ide.llm.TokenListener
import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Properties

class ExplainSchemaTest {

    private val catalog = SchemaCatalog(
        engine = EngineKind.POSTGRES,
        schemas = listOf("shop"),
        tables = listOf(
            TableInfo(
                schema = "shop", name = "customers", kind = TableKind.TABLE,
                columns = listOf(ColumnInfo("id", "bigint", false), ColumnInfo("region", "text", true)),
            ),
            TableInfo(
                schema = "shop", name = "orders", kind = TableKind.TABLE,
                columns = listOf(
                    ColumnInfo("id", "bigint", false),
                    ColumnInfo("customer_id", "bigint", false),
                    ColumnInfo("total_cents", "bigint", false),
                ),
            ),
        ),
    )

    // ---- grounding floor ----

    @Test fun `passes prose that only names real tables and columns`() {
        val prose = "The orders table links to customers via customer_id, and total_cents holds the amount."
        assertEquals(emptyList<String>(), EnginePipeline.unknownReferencesInProse(prose, catalog))
    }

    @Test fun `flags an invented snake_case name`() {
        val prose = "Join orders to the customer_history table."
        assertTrue(EnginePipeline.unknownReferencesInProse(prose, catalog).contains("customer_history"))
    }

    @Test fun `flags backticked and quoted invented names`() {
        assertTrue(EnginePipeline.unknownReferencesInProse("See `line_items`.", catalog).contains("line_items"))
        assertTrue(EnginePipeline.unknownReferencesInProse("Look at \"audit_log\".", catalog).contains("audit_log"))
    }

    @Test fun `does not flag ordinary English or SQL vocabulary`() {
        val prose = "Each order has a primary_key and a foreign_key to the customer. This is read_only."
        assertEquals(emptyList<String>(), EnginePipeline.unknownReferencesInProse(prose, catalog))
    }

    // ---- explainSchema end to end (file-backed SQLite + fixed LLM) ----

    private class FixedLlm(private val reply: String) : LlmClient {
        var calls = 0
            private set
        override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?): LlmResult {
            calls++
            return LlmResult(reply, LlmUsage())
        }
        override suspend fun listModels(): List<String> = emptyList()
    }

    private class SequentialLlm(private val replies: List<String>) : LlmClient {
        private var i = 0
        override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?) =
            LlmResult(replies[minOf(i++, replies.size - 1)], LlmUsage())
        override suspend fun listModels(): List<String> = emptyList()
    }

    private fun seedDb(): File {
        val file = File.createTempFile("asksql-explainschema", ".sqlite")
        file.deleteOnExit()
        org.sqlite.JDBC().connect("jdbc:sqlite:${file.path}", Properties())!!.use { seed ->
            seed.createStatement().use { st ->
                st.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
                st.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL)")
            }
        }
        return file
    }

    private fun pipeline() =
        EnginePipeline(ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))

    private fun descriptor(f: File) = ConnectionDescriptor(
        id = "es", name = "es", engine = EngineKind.SQLITE, scope = ConnectionScope.PROJECT, filePath = f.path,
    )

    @Test fun `explainSchema returns a grounded answer and never runs a query`() = runTest {
        val db = descriptor(seedDb())
        val sa = pipeline().explainSchema(
            "How are orders and customers related?", db, null,
            FixedLlm("The orders table links to customers via its customer_id column."),
        )
        assertTrue(sa.grounded)
        assertEquals(emptyList<String>(), sa.unknownReferences)
        assertTrue(sa.answer.contains("orders"))
        assertTrue(sa.tables.contains("customers"))
    }

    @Test fun `explainSchema repairs an ungrounded understanding answer on one retry`() = runTest {
        val db = descriptor(seedDb())
        val sa = pipeline().explainSchema(
            "Where is revenue stored?", db, null,
            SequentialLlm(
                listOf(
                    "Revenue is in the monthly_totals table.", // ungrounded
                    "Order rows live in the orders table, linked to customers.", // grounded retry
                ),
            ),
        )
        assertTrue(sa.grounded)
        assertEquals(emptyList<String>(), sa.unknownReferences)
        assertFalse(sa.isSchemaChange)
    }

    @Test fun `explainSchema treats a schema-change request as a read-only proposal without retrying`() = runTest {
        val db = descriptor(seedDb())
        val llm = FixedLlm("To add it, run: ALTER TABLE customers ADD COLUMN loyalty_points int. AskSQL is read-only and will not run it.")
        val sa = pipeline().explainSchema("Add a loyalty_points column to customers", db, null, llm)
        assertTrue(sa.isSchemaChange)
        assertTrue(sa.unknownReferences.contains("loyalty_points")) // surfaced as a proposal
        assertEquals(1, llm.calls) // no repair retry for a change request
    }
}
