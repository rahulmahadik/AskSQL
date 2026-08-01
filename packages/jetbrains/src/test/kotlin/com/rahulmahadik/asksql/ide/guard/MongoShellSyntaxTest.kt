package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.MongoGuardPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Smaller local models emit mongo-shell syntax (unquoted keys, single quotes) rather than strict
 * JSON. Core relaxes its parser for the same reason; these assert the plugin accepts the same input
 * without relaxing what the guard rejects.
 */
class MongoShellSyntaxTest {

    private val policy = MongoGuardPolicy()

    @Test fun `unquoted stage keys parse`() {
        val v = MongoGuard.guard("""[{${'$'}group: {_id: "${'$'}customer_id", n: {${'$'}sum: 1}}}]""", policy)
        assertTrue(v.reason ?: "allowed", v.allowed)
        assertTrue(v.pipelineJson.contains("\$group"))
    }

    @Test fun `single-quoted strings parse`() {
        val v = MongoGuard.guard("""[{${'$'}match: {status: 'shipped'}}]""", policy)
        assertTrue(v.reason ?: "allowed", v.allowed)
        assertTrue(v.pipelineJson.contains("shipped"))
    }

    @Test fun `colons and braces inside a string value survive`() {
        val v = MongoGuard.guard("""[{${'$'}match: {note: "a:b, {c} d"}}]""", policy)
        assertTrue(v.allowed)
        assertTrue(v.pipelineJson.contains("a:b, {c} d"))
    }

    // Asserting only `allowed == false` would pass even if the pipeline never parsed at all,
    // which is exactly the regression these guard: it must REACH the guard and be rejected there.
    @Test fun `a forbidden operator in shell syntax is still blocked`() {
        val v = MongoGuard.guard("""[{${'$'}match: {${'$'}where: "this.total > 0"}}]""", policy)
        assertFalse(v.allowed)
        assertNotEquals("parse_failed", v.ruleId)
    }

    @Test fun `a write stage in shell syntax is still blocked`() {
        val v = MongoGuard.guard("""[{${'$'}out: "stolen"}]""", policy)
        assertFalse(v.allowed)
        assertNotEquals("parse_failed", v.ruleId)
    }

    @Test fun `text that is not a pipeline is rejected`() {
        val v = MongoGuard.guard("not a pipeline", policy)
        assertFalse(v.allowed)
        assertEquals("parse_failed", v.ruleId)
    }
}
