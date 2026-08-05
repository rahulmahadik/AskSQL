package com.rahulmahadik.asksql.ide.engine

import com.google.gson.JsonParser
import com.rahulmahadik.asksql.ide.model.Dialects
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Asserts [Prompts] output is BYTE-IDENTICAL to the published `@asksql/core` fixture
 * (`tools/parity/vectors/prompts.json`): upstream prompt quality is inherited only if the strings are identical.
 */
class PromptParityTest {

    private fun loadVectors(): Map<String, String> {
        val candidates = listOf(
            File("tools/parity/vectors/prompts.json"),
            File("../tools/parity/vectors/prompts.json"),
            File(System.getProperty("user.dir"), "tools/parity/vectors/prompts.json"),
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error("prompts.json golden vectors not found - run `./gradlew parityVectors` first")
        val obj = JsonParser.parseString(file.readText()).asJsonObject
        return obj.entrySet().associate { it.key to it.value.asString }
    }

    private val schemaText = listOf(
        "TABLE users [~1200 rows]",
        " id integer PK NOT NULL",
        " name text NOT NULL",
        " email text",
        "TABLE orders [~5400 rows]",
        " id integer PK NOT NULL",
        " user_id integer FK->users.id NOT NULL",
        " total_cents integer NOT NULL",
        "RELATIONSHIPS (join paths):",
        " orders.user_id = users.id",
    ).joinToString("\n")

    @Test
    fun `system prompt matches published core byte for byte`() {
        val vectors = loadVectors()
        val actual = Prompts.buildSqlSystem(Dialects.POSTGRES, 1000)
        assertEquals(vectors.getValue("system"), actual)
    }

    @Test
    fun `user prompt matches published core byte for byte`() {
        val vectors = loadVectors()
        val actual = Prompts.buildSqlUser(
            question = "top 5 customers by total spend",
            schemaText = schemaText,
        )
        assertEquals(vectors.getValue("user"), actual)
    }

    @Test
    fun `repair prompt matches published core byte for byte`() {
        val vectors = loadVectors()
        val actual = Prompts.buildRepairUser(
            question = "top 5 customers by total spend",
            failedSql = "SELECT * FROM userz",
            failure = "Table \"userz\" does not exist in the schema. Use only tables from the <schema> block.",
            schemaText = schemaText,
            dialect = Dialects.POSTGRES,
        )
        assertEquals(vectors.getValue("repair"), actual)
    }

    @Test
    fun `schema-answer system prompts match published core byte for byte`() {
        val vectors = loadVectors()
        assertEquals(vectors.getValue("schemaAnswerSystem"), Prompts.buildSchemaAnswerSystem(Dialects.POSTGRES))
        assertEquals(vectors.getValue("schemaAnswerSystemDdl"), Prompts.buildSchemaAnswerSystem(Dialects.POSTGRES, allowDdlSuggestions = true))
        assertEquals(
            vectors.getValue("schemaAnswerSystemNoScope"),
            Prompts.buildSchemaAnswerSystem(Dialects.POSTGRES, allowDdlSuggestions = false, allowOutOfScope = false),
        )
    }

    @Test
    fun `schema-answer user and scope-repair prompts match published core byte for byte`() {
        val vectors = loadVectors()
        assertEquals(
            vectors.getValue("schemaAnswerUser"),
            Prompts.buildSchemaAnswerUser("what is this database for?", schemaText, listOf("orders.user_id = users.id")),
        )
        assertEquals(
            vectors.getValue("schemaAnswerScopeRepair"),
            Prompts.buildSchemaAnswerScopeRepairUser(
                "how would I do this in MongoDB?",
                schemaText,
                Dialects.POSTGRES.promptLabel,
                listOf("orders.user_id = users.id"),
            ),
        )
    }

    /**
     * Verdict parity, not source parity: identical regex text can still behave differently
     * across the two regex engines (flags, escaping, word boundaries).
     */
    @Test
    fun `scope classifiers agree with published core on every probe`() {
        val file = listOf(
            File("tools/parity/vectors/classifiers.json"),
            File("../tools/parity/vectors/classifiers.json"),
            File(System.getProperty("user.dir"), "tools/parity/vectors/classifiers.json"),
        ).firstOrNull { it.exists() } ?: error("classifiers.json not found - run `./gradlew parityVectors` first")
        val obj = JsonParser.parseString(file.readText()).asJsonObject

        for (e in obj.getAsJsonObject("looksDatabaseRelated").entrySet()) {
            assertEquals("looksDatabaseRelated(${e.key})", e.value.asBoolean, Scope.looksDatabaseRelated(e.key))
        }
        for (e in obj.getAsJsonObject("isOffTopic").entrySet()) {
            assertEquals("isOffTopic(${e.key})", e.value.asBoolean, Scope.isOffTopic(e.key))
        }

        // Every routing decision, not just the two scope classifiers. This is the check that was
        // missing while the Kotlin advice and metadata vocabularies sat months behind core's.
        for (e in obj.getAsJsonObject("routing").entrySet()) {
            val q = e.key
            val want = e.value.asJsonObject
            val got = mapOf(
                "metadata" to EnginePipeline.isMetadataQuestion(q),
                "advice" to EnginePipeline.isSchemaAdviceQuestion(q),
                "overview" to EnginePipeline.isDatabaseOverviewQuestion(q),
                "proposal" to EnginePipeline.isSchemaProposalQuestion(q),
                "write" to EnginePipeline.isWriteRequest(q),
                "capability" to Scope.isCapabilityQuestion(q),
                "injection" to Scope.isPromptInjection(q),
            )
            for ((name, actual) in got) {
                assertEquals("$name(\"$q\")", want.get(name).asBoolean, actual)
            }
        }
    }
}
