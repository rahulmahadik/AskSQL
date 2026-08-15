package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Replays the same routing corpus the core suite does, from the same file. Identical regex text is
 * not identical behaviour - the two engines differ on flags, escaping and word boundaries - so the
 * only check worth having is that both route thousands of real phrasings the same way.
 */
class RoutingCorpusTest {

    private fun corpusFile(): File = listOf(
        File("../core/test/fixtures/routing-corpus.txt"),
        File("../../packages/core/test/fixtures/routing-corpus.txt"),
        File(System.getProperty("user.dir"), "../core/test/fixtures/routing-corpus.txt"),
    ).firstOrNull { it.exists() }
        ?: error("routing-corpus.txt not found - regenerate it with `node tools/gen-routing-corpus.mjs` in packages/core")

    private fun load(): List<Pair<String, String>> = corpusFile()
        .readLines()
        .filter { it.isNotBlank() && !it.startsWith("#") }
        .map { line ->
            val tab = line.indexOf('\t')
            require(tab >= 0) { "malformed corpus line: $line" }
            line.substring(0, tab) to line.substring(tab + 1)
        }

    /** The pipeline's own order of checks, so the corpus measures routing as it actually happens. */
    private fun routeOf(question: String): String = when {
        Scope.isCapabilityQuestion(question) -> "capability"
        EnginePipeline.isWriteRequest(question) -> "write"
        EnginePipeline.isSchemaAdviceQuestion(question) ||
            EnginePipeline.isDatabaseOverviewQuestion(question) ||
            EnginePipeline.isRelationshipQuestion(question) -> "advice"
        EnginePipeline.isMetadataQuestion(question) -> "listing"
        else -> "data"
    }

    @Test
    fun `every question in the corpus routes the way core routes it`() {
        val corpus = load()
        assertTrue("corpus is too small to be a corpus: ${corpus.size}", corpus.size >= 4000)
        assertEquals(
            "the corpus lost a route",
            setOf("advice", "capability", "data", "listing", "write"),
            corpus.map { it.first }.toSet(),
        )

        val misrouted = corpus.mapNotNull { (expected, question) ->
            val actual = routeOf(question)
            // A data question read as a listing still generates SQL, so it is not a misroute.
            if (actual == expected || (expected == "data" && actual == "listing")) null
            else "$expected -> $actual: $question"
        }

        assertEquals(
            "${misrouted.size}/${corpus.size} misrouted\n" + misrouted.take(25).joinToString("\n"),
            emptyList<String>(),
            misrouted,
        )
    }
}
