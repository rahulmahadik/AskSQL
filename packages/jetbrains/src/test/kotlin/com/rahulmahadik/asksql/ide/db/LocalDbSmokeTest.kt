package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.engine.EnginePipeline
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
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Drives the whole plugin path - open, introspect, guard, execute - against a local database given by
 * ASKSQL_LOCAL_DB. Skips when unset, so it never runs in CI and names no particular file.
 */
class LocalDbSmokeTest {

    private class FixedLlm(private val sql: String) : LlmClient {
        override suspend fun chat(system: String, userPrompt: String, onToken: TokenListener?): LlmResult =
            LlmResult("```sql\n$sql\n```\nA query.", LlmUsage())
        override suspend fun listModels(): List<String> = emptyList()
    }

    @Test
    fun `a local database opens, introspects and answers through the real pipeline`() = runTest {
        val path = System.getenv("ASKSQL_LOCAL_DB")
        assumeTrue("ASKSQL_LOCAL_DB not set", !path.isNullOrBlank() && File(path).isFile)

        val registry = ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val pipeline = EnginePipeline(registry)
        val descriptor = ConnectionDescriptor(
            id = "local", name = "local", engine = EngineKind.SQLITE,
            scope = ConnectionScope.PROJECT, filePath = path,
        )

        val catalog = pipeline.catalog(descriptor, null)
        println("SMOKE tables=${catalog.tables.size} columns=${catalog.tables.sumOf { it.columns.size }}")

        // Pick a table that actually holds rows, so the run proves data flows rather than that an empty
        // table counts to zero. Chosen at runtime, so no particular table is named here.
        val biggest = catalog.tables
            .maxByOrNull { t ->
                runCatching { pipeline.execute("SELECT COUNT(*) FROM \"${t.name}\"", descriptor, null).rows.first().first() }
                    .getOrNull()?.toString()?.filter { it.isDigit() }?.toLongOrNull() ?: 0L
            }!!
        val result = pipeline.ask(
            "how many rows are there?",
            descriptor,
            null,
            FixedLlm("SELECT COUNT(*) AS n FROM \"${biggest.name}\""),
        )
        println("SMOKE guardAllowed=${result.guard.allowed} sql=${result.sql.replace("\n", " ").take(120)}")
        val rows = pipeline.execute(result.sql, descriptor, null)
        println("SMOKE rows=${rows.rows.size} firstCell=${rows.rows.firstOrNull()?.firstOrNull()}")
    }
}
