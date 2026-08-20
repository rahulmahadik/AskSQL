package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.llm.LlmClient
import com.rahulmahadik.asksql.ide.llm.LlmResult
import com.rahulmahadik.asksql.ide.llm.LlmUsage
import com.rahulmahadik.asksql.ide.llm.TokenListener
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Properties

/**
 * An integer status column carries no meaning in the database: what 1 means lives in the application. So
 * the model picks an ordinal, and a wrong pick matches no row - the zero that comes back is
 * indistinguishable from a true zero. Measured on the Room fixture: "How many orders are paid?" wrote
 * `status = 2`, returned 0, truth 2.
 *
 * The values are read from the database and kept local. Naming them to the model is row data, which only
 * `allowDataInPrompt` permits. Mirrors tests/coded-value-floor.test.ts.
 */
class CodedValueFloorTest {

    /** Statuses present are 0, 1 and 3. Nothing holds 2, the ordinal a model tends to guess. */
    private fun seedDb(extra: String = ""): File {
        val file = File.createTempFile("asksql-codes", ".sqlite")
        file.deleteOnExit()
        org.sqlite.JDBC().connect("jdbc:sqlite:${file.path}", Properties())!!.use { seed ->
            seed.createStatement().use { st ->
                st.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
                st.execute("CREATE TABLE tickets (id INTEGER PRIMARY KEY, status INTEGER)")
                st.execute(
                    "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, status INTEGER, " +
                        "total_cents INTEGER, placed_at INTEGER, FOREIGN KEY (user_id) REFERENCES users(id))",
                )
                st.execute("INSERT INTO users VALUES (1, 'Ada'), (2, 'Grace')")
                st.execute(
                    "INSERT INTO orders VALUES (1, 1, 0, 500, 1755300000000), (2, 1, 1, 900, 1755300000001), " +
                        "(3, 2, 1, 250, 1755300000002), (4, 2, 3, 1999, 1755300000003)",
                )
                if (extra.isNotBlank()) st.execute(extra)
            }
        }
        return file
    }

    private class FixedLlm(private val reply: String) : LlmClient {
        val prompts = mutableListOf<String>()
        override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?): LlmResult {
            prompts += system
            prompts += userPrompt
            return LlmResult("```sql\n$reply\n```\nA query.", LlmUsage())
        }
        override suspend fun listModels(): List<String> = emptyList()
    }

    private data class Asked(val sql: String, val warnings: String, val prompts: String)

    private suspend fun ask(sql: String, allowData: Boolean = false, dbFile: File = seedDb()): Asked {
        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry).also { it.allowDataInPrompt = allowData }
        val llm = FixedLlm(sql)
        val descriptor = ConnectionDescriptor(
            id = "codes", name = "codes", engine = EngineKind.SQLITE, scope = ConnectionScope.PROJECT,
            filePath = dbFile.path,
        )
        val result = pipeline.ask("how many orders are paid?", descriptor, null, llm)
        return Asked(result.sql, result.guard.warnings.joinToString(" "), llm.prompts.joinToString("\n"))
    }

    @Test
    fun `a status the table does not have is reported`() = runTest {
        val asked = ask("SELECT COUNT(*) FROM orders WHERE status = 2")
        assertTrue(asked.warnings, asked.warnings.contains("orders.status = 2"))
        assertTrue(asked.warnings, asked.warnings.contains("defined in the application"))
    }

    @Test
    fun `a status that does exist is left alone`() = runTest {
        val asked = ask("SELECT COUNT(*) FROM orders WHERE status = 1")
        assertFalse(asked.warnings, asked.warnings.contains("No row has"))
    }

    @Test
    fun `an identifier is left alone, where an absent value is an ordinary empty result`() = runTest {
        for (sql in listOf(
            "SELECT * FROM orders WHERE id = 99",
            "SELECT * FROM orders WHERE user_id = 99",
            "SELECT * FROM users WHERE id = 99",
        )) {
            val asked = ask(sql)
            assertFalse(sql, asked.warnings.contains("No row has"))
        }
    }

    @Test
    fun `a moment compared with an epoch bound is left alone`() = runTest {
        val asked = ask("SELECT * FROM orders WHERE placed_at = 1755300000009")
        assertFalse(asked.warnings, asked.warnings.contains("No row has"))
    }

    @Test
    fun `a column with too many distinct values to be a code is left alone`() = runTest {
        // total_cents is a measurement: an absent amount is a real answer, not a guess.
        val db = seedDb(
            "INSERT INTO orders (user_id, status, total_cents, placed_at) " +
                "SELECT 1, 1, value, 1755300000000 FROM (WITH RECURSIVE n(value) AS (" +
                "SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 60) SELECT value FROM n)",
        )
        val asked = ask("SELECT * FROM orders WHERE total_cents = 777777", dbFile = db)
        assertFalse(asked.warnings, asked.warnings.contains("No row has"))
    }

    @Test
    fun `the values stay out of the prompt by default`() = runTest {
        val asked = ask("SELECT COUNT(*) FROM orders WHERE status = 2")
        // The schema IS sent, which proves the check below ran against real prompts.
        assertTrue(asked.prompts.contains("orders"))
        assertFalse(asked.prompts.contains("values it actually holds"))
        // The caveat is for the reader; the SQL is left as the model wrote it.
        assertTrue(asked.sql.contains("status = 2"))
    }

    @Test
    fun `the values are named in a repair only when data in the prompt is allowed`() = runTest {
        val asked = ask("SELECT COUNT(*) FROM orders WHERE status = 2", allowData = true)
        assertTrue(asked.prompts.contains("No row has orders.status = 2"))
        assertTrue(asked.prompts.contains("values it actually holds are: 0, 1, 3"))
    }

    /**
     * Only a literal that DETERMINES emptiness may be reported: under OR, NOT, CASE or a partial IN the
     * query returns rows and the caveat would contradict the answer beside it. Mirrors
     * tests/coded-value-floor.test.ts.
     */
    @Test
    fun `only a literal that decides the result is reported`() = runTest {
        for (sql in listOf(
            "SELECT COUNT(*) FROM orders WHERE status = 2 OR total_cents > 1",
            "SELECT SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) FROM orders",
            "SELECT * FROM orders WHERE NOT (status = 2)",
            "SELECT COUNT(*) FROM orders WHERE status IN (0,2)",
        )) {
            assertFalse(sql, ask(sql).warnings.contains("No row has"))
        }
        assertTrue(ask("SELECT COUNT(*) FROM orders WHERE status = 2 AND total_cents > 1").warnings.contains("orders.status = 2"))
    }

    @Test
    fun `a column is resolved when another table shares its name`() = runTest {
        // Judged against the whole catalog, `status` on two tables made every reference ambiguous.
        assertTrue(ask("SELECT COUNT(*) FROM orders o WHERE o.status = 2").warnings.contains("orders.status = 2"))
        assertTrue(ask("SELECT COUNT(*) FROM orders WHERE orders.status = 2").warnings.contains("orders.status = 2"))
    }

    @Test
    fun `a negative literal is read, since minus one is the conventional unset sentinel`() = runTest {
        assertTrue(ask("SELECT COUNT(*) FROM orders WHERE status = -1").warnings.contains("orders.status = -1"))
    }
}
