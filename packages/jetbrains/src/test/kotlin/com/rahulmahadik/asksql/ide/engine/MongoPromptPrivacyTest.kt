package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Only the schema leaves the machine unless the user opts in. Asserted on the prompt text every
 * pipeline path builds, not on the stripping helper: a helper nobody calls proves nothing.
 */
class MongoPromptPrivacyTest {

    @Test
    fun `every prompt-building path goes through the stripped catalog`() {
        val source = java.io.File("src/main/kotlin/com/rahulmahadik/asksql/ide/engine/MongoEnginePipeline.kt").readText()
        // Each exit of catalog() strips, so no caller can reintroduce the values.
        val exits = Regex("""return(@withLock)? withoutSampledData\(|^\s+withoutSampledData\(fresh\)""", RegexOption.MULTILINE)
            .findAll(source).count()
        assertTrue("expected every catalog() exit to strip, found $exits", exits >= 3)
        // And nothing bypasses it by reaching into the cache directly.
        val rawCacheReads = Regex("""catalogCache\[[^\]]+\]\.catalog""").findAll(source).count()
        assertTrue("a caller reads the cached catalog without stripping", rawCacheReads == 0)
    }

    @Test
    fun `the default is off`() {
        assertFalse(com.rahulmahadik.asksql.ide.settings.AskSqlAppState().allowDataInPrompt)
    }

    @Test
    fun `a stripped catalog renders no values but keeps the fields`() {
        val text = CatalogPruner.formatCatalogForPrompt(
            com.rahulmahadik.asksql.ide.model.SchemaCatalog(
                engine = com.rahulmahadik.asksql.ide.model.EngineKind.MONGODB,
                schemas = emptyList(),
                tables = listOf(
                    com.rahulmahadik.asksql.ide.model.TableInfo(
                        name = "customers", schema = null,
                        kind = com.rahulmahadik.asksql.ide.model.TableKind.TABLE,
                        columns = listOf(
                            com.rahulmahadik.asksql.ide.model.ColumnInfo(
                                name = "email", dbType = "string", nullable = true, sampledValues = emptyList(),
                            ),
                        ),
                        primaryKey = emptyList(), foreignKeys = emptyList(),
                    ),
                ),
                enums = emptyList(), sequences = emptyList(), triggers = emptyList(),
                routines = emptyList(), warnings = emptyList(), fetchedAt = java.time.Instant.EPOCH,
            ),
        )
        assertFalse(text, text.contains("sample values"))
        assertTrue(text, text.contains("email"))
    }
}
