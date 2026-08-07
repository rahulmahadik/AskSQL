package com.rahulmahadik.asksql.ide.guard

import com.google.gson.JsonParser
import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineKind
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Replays the golden guard vectors generated from published `@asksql/core`: every vector core
 * blocks must also be blocked here. A vector core allows is only logged if this guard's parser
 * disagrees, since a JSqlParser grammar gap failing safe (over-blocking) is a UX issue, not a security one.
 */
class GuardVectorTest {

    private data class Vector(
        val sql: String,
        val engine: String,
        val allowed: Boolean,
        val ruleId: String?,
        val autoLimited: Boolean,
        val loweredLimit: Boolean,
    )

    private fun loadVectors(): List<Vector> {
        val candidates = listOf(
            File("tools/parity/vectors/guard.json"),
            File("../tools/parity/vectors/guard.json"),
            File(System.getProperty("user.dir"), "tools/parity/vectors/guard.json"),
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error("guard.json golden vectors not found - run `./gradlew parityVectors` first")
        val array = JsonParser.parseString(file.readText()).asJsonArray
        return array.map { el ->
            val obj = el.asJsonObject
            Vector(
                sql = obj.get("sql").asString,
                engine = obj.get("engine").asString,
                allowed = obj.get("allowed").asBoolean,
                ruleId = obj.get("ruleId")?.takeIf { !it.isJsonNull }?.asString,
                autoLimited = obj.get("autoLimited")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
                loweredLimit = obj.get("loweredLimit")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
            )
        }
    }

    @Test
    fun `Kotlin guard never allows what core blocks`() {
        val vectors = loadVectors()
        val unexpectedAllows = mutableListOf<String>()
        var overBlocks = 0

        for (vector in vectors) {
            val dialect = Dialects.of(EngineKind.fromWireName(vector.engine))
            val verdict = SqlGuard.guard(vector.sql, dialect)

            if (!vector.allowed && verdict.allowed) {
                unexpectedAllows += "core BLOCKED (${vector.ruleId}) but Kotlin ALLOWED: ${vector.sql}"
            }
            if (vector.allowed && !verdict.allowed) {
                overBlocks++
                println("PARITY DIVERGENCE (safe direction - over-block, not a security issue): core allowed but Kotlin blocked (${verdict.ruleId}): ${vector.sql}")
            }
        }

        assertTrue(
            "Kotlin guard allowed SQL that core blocks - this is the unsafe direction and must never happen:\n" +
                unexpectedAllows.joinToString("\n"),
            unexpectedAllows.isEmpty(),
        )
        println("Guard parity: ${vectors.size} vectors, 0 unsafe divergences, $overBlocks safe (over-block) divergences")
    }

    /**
     * The rewritten SQL itself cannot be compared - JSqlParser and node-sql-parser format
     * differently - but how each guard bounded the statement can be. A statement core leaves alone
     * while this guard appends a second LIMIT to is invalid SQL, and the reverse is an uncapped read.
     */
    @Test
    fun `the row cap is applied the same way as core`() {
        val divergences = mutableListOf<String>()
        for (vector in loadVectors().filter { it.allowed }) {
            val dialect = Dialects.of(EngineKind.fromWireName(vector.engine))
            val verdict = SqlGuard.guard(vector.sql, dialect)
            if (!verdict.allowed) continue
            if (verdict.autoLimited != vector.autoLimited || verdict.loweredLimit != vector.loweredLimit) {
                divergences += "core(auto=${vector.autoLimited}, lowered=${vector.loweredLimit}) " +
                    "kotlin(auto=${verdict.autoLimited}, lowered=${verdict.loweredLimit}): ${vector.sql}"
            }
        }
        assertTrue("row cap applied differently from core:\n" + divergences.joinToString("\n"), divergences.isEmpty())
    }
}
