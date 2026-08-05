package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.MongoGuardPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Security-property tests for [MongoGuard]. Unlike [SqlGuardTest], there is
 * no `@asksql/core` parity corpus to also replay here; this suite is the
 * only safety net MongoDB's guard has (see the class doc on [MongoGuard]).
 */
class MongoGuardTest {

    private fun guard(json: String, policy: MongoGuardPolicy = MongoGuardPolicy()) = MongoGuard.guard(json, policy)

    @Test fun `allows a simple match pipeline and auto-appends a limit`() {
        val v = guard("""[{"${'$'}match": {"status": "active"}}]""")
        assertTrue(v.allowed)
        assertTrue(v.autoLimited)
        assertTrue(v.pipelineJson.contains("\$limit"))
    }

    // Pins the guard-output-is-guard-input contract: pipelineJson must be a
    // bare array, not wrapped, since execute() re-guards it and parsePipeline
    // re-parses it; both expect the exact shape a caller originally passed in.
    @Test fun `pipelineJson round-trips through guard and parsePipeline again`() {
        val first = guard("""[{"${'$'}match": {"status": "active"}}]""")
        assertTrue(first.allowed)
        assertTrue(first.pipelineJson.trim().startsWith("["))

        val second = guard(first.pipelineJson)
        assertTrue("re-guarding the verdict's own pipelineJson must succeed", second.allowed)

        val stages = MongoGuard.parsePipeline(first.pipelineJson)
        assertEquals(2, stages.size) // the original $match stage plus the auto-appended $limit
    }

    @Test fun `blocks a blank pipeline but allows the empty one`() {
        assertFalse(guard("   ").allowed)
        // `[]` is valid MongoDB and core auto-limits it; a model dodging with it is caught by
        // MongoEnginePipeline.isNoOpPipeline, not here.
        assertTrue(guard("[]").allowed)
    }

    @Test fun `blocks unparseable garbage fail-closed`() {
        assertFalse(guard("not json at all {{{").allowed)
    }

    @Test fun `blocks a bare object instead of an array`() {
        assertFalse(guard("""{"status": "active"}""").allowed)
    }

    // ---- Parser StackOverflowError, not just JsonParseException ----
    // BSON's extended-JSON parser is recursive-descent; pathologically deep
    // nesting overflows the stack DURING PARSING, before any of this guard's
    // own depth checks ever run. That must fail closed too, not crash.

    @Test fun `blocks a pathologically deeply nested array without crashing`() {
        val deep = "[".repeat(50_000) + "]".repeat(50_000)
        val v = guard(deep)
        assertFalse(v.allowed)
    }

    @Test fun `blocks a stage with more than one key`() {
        assertFalse(guard("""[{"${'$'}match": {}, "${'$'}sort": {}}]""").allowed)
    }

    // ---- Stage allowlist ----

    @Test fun `blocks out stage`() {
        assertFalse(guard("""[{"${'$'}match": {}}, {"${'$'}out": "evil"}]""").allowed)
    }

    @Test fun `blocks merge stage`() {
        assertFalse(guard("""[{"${'$'}merge": {"into": "evil"}}]""").allowed)
    }

    @Test fun `blocks currentOp stage`() {
        assertFalse(guard("""[{"${'$'}currentOp": {}}]""").allowed)
    }

    @Test fun `blocks collStats stage`() {
        assertFalse(guard("""[{"${'$'}collStats": {}}]""").allowed)
    }

    @Test fun `allows a rich but read-only pipeline`() {
        val v = guard(
            """
            [
                {"${'$'}match": {"status": "active"}},
                {"${'$'}group": {"_id": "${'$'}category", "total": {"${'$'}sum": "${'$'}amount"}}},
                {"${'$'}sort": {"total": -1}},
                {"${'$'}limit": 10}
            ]
            """.trimIndent(),
        )
        assertTrue(v.allowed)
    }

    @Test fun `allows an Atlas Search dollar-search stage`() {
        val json = """[{"${'$'}search": {"text": {"query": "widget", "path": "name"}}}, {"${'$'}limit": 10}]"""
        assertTrue(guard(json).allowed)
    }

    @Test fun `allows an Atlas Search dollar-searchMeta stage`() {
        val json = """[{"${'$'}searchMeta": {"count": {"type": "total"}}}]"""
        assertTrue(guard(json).allowed)
    }

    // ---- Denied operators, anywhere in the tree ----

    @Test fun `blocks where at top level of a match filter`() {
        assertFalse(guard("""[{"${'$'}match": {"${'$'}where": "this.x == 1"}}]""").allowed)
    }

    @Test fun `blocks function hidden inside expr`() {
        val json = """[{"${'$'}match": {"${'$'}expr": {"${'$'}function": {"body": "function(){return true}", "args": [], "lang": "js"}}}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `blocks accumulator hidden inside group`() {
        val json = """[{"${'$'}group": {"_id": null, "r": {"${'$'}accumulator": {"init": "function(){}", "accumulate": "function(){}", "accumulateArgs": [], "merge": "function(){}", "lang": "js"}}}}]"""
        assertFalse(guard(json).allowed)
    }

    // ---- Recursive nested-pipeline walking ----

    @Test fun `blocks out hidden inside a lookup sub-pipeline`() {
        val json = """[{"${'$'}lookup": {"from": "orders", "as": "o", "pipeline": [{"${'$'}out": "evil"}]}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `blocks merge hidden inside a unionWith sub-pipeline`() {
        val json = """[{"${'$'}unionWith": {"coll": "orders", "pipeline": [{"${'$'}merge": {"into": "evil"}}]}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `blocks where hidden inside a facet branch`() {
        val json = """[{"${'$'}facet": {"branchA": [{"${'$'}match": {"${'$'}where": "1"}}], "branchB": [{"${'$'}count": "n"}]}}]"""
        assertFalse(guard(json).allowed)
    }

    /** A $facet branch returns its rows inside ONE output document, which the top-level $limit counts as a single row. */
    @Test fun `caps every facet branch, not just the top level`() {
        val json = """[{"${'$'}facet": {"rows": [{"${'$'}match": {"status": "paid"}}], "counted": [{"${'$'}count": "n"}]}}]"""
        val v = guard(json)
        assertTrue(v.allowed)
        assertTrue(v.autoLimited)

        val facet = MongoGuard.parsePipeline(v.pipelineJson).first()["\$facet"] as org.bson.Document
        for (branch in listOf("rows", "counted")) {
            val stages = facet.getList(branch, org.bson.Document::class.java)
            val limit = (stages.lastOrNull()?.get("\$limit") as? Number)?.toLong() ?: 0L
            assertEquals("the \"$branch\" branch needs its own cap", 1000L, limit)
        }
    }

    @Test fun `lowers a high limit inside a facet branch`() {
        val json = """[{"${'$'}facet": {"rows": [{"${'$'}match": {"status": "paid"}}, {"${'$'}limit": 500000}]}}]"""
        val v = guard(json)
        assertTrue(v.allowed)
        assertTrue(v.loweredLimit)
        val facet = MongoGuard.parsePipeline(v.pipelineJson).first()["\$facet"] as org.bson.Document
        val stages = facet.getList("rows", org.bson.Document::class.java)
        assertEquals(1000L, (stages.last()["\$limit"] as Number).toLong())
    }

    @Test fun `allows a legitimate nested lookup pipeline`() {
        val json = """[{"${'$'}lookup": {"from": "orders", "as": "o", "pipeline": [{"${'$'}match": {"status": "paid"}}]}}]"""
        assertTrue(guard(json).allowed)
    }

    // ---- ReDoS mitigation ----

    @Test fun `blocks an excessively long regex pattern`() {
        val longPattern = "a".repeat(500)
        val json = """[{"${'$'}match": {"name": {"${'$'}regex": "$longPattern"}}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `allows a short regex pattern`() {
        val json = """[{"${'$'}match": {"name": {"${'$'}regex": "^ab.*"}}}]"""
        assertTrue(guard(json).allowed)
    }

    // A length cap alone does not stop classic catastrophic-backtracking
    // shapes like (a+)+; short, well under any reasonable length limit,
    // still exponential.

    @Test fun `blocks a short but catastrophically-backtracking regex pattern`() {
        val json = """[{"${'$'}match": {"name": {"${'$'}regex": "(a+)+$"}}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `blocks a star-based nested quantifier regex pattern`() {
        val json = """[{"${'$'}match": {"name": {"${'$'}regex": "(a*)*"}}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `blocks a nested quantifier regex pattern over a character class`() {
        val json = """[{"${'$'}match": {"name": {"${'$'}regex": "([a-z]+)+"}}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `allows an ordinary regex pattern with a single quantifier`() {
        val json = """[{"${'$'}match": {"name": {"${'$'}regex": "^[a-z]+ [0-9]{3}$"}}}]"""
        assertTrue(guard(json).allowed)
    }

    @Test fun `catches a ReDoS pattern hidden in a regex operator field, not just a bare regex`() {
        // $regexMatch carries the pattern under "regex", bypassing a $regex-only check.
        val json = """[{"${'$'}project": {"m": {"${'$'}regexMatch": {"input": "${'$'}x", "regex": "(a+)+${'$'}"}}}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `catches a ReDoS pattern in an EJSON regular expression value`() {
        val json = """[{"${'$'}match": {"name": {"${'$'}regularExpression": {"pattern": "(a+)+${'$'}", "options": ""}}}}]"""
        assertFalse(guard(json).allowed)
    }

    // ---- Unbounded array accumulators (memory bound) ----

    @Test fun `rejects a group that pushes every document into one array with no prior bound`() {
        val json = """[{"${'$'}group": {"_id": null, "all": {"${'$'}push": "${'$'}${'$'}ROOT"}}}]"""
        assertFalse(guard(json).allowed)
    }

    @Test fun `allows a bounded push when a limit precedes the group`() {
        val json = """[{"${'$'}limit": 50}, {"${'$'}group": {"_id": null, "all": {"${'$'}push": "${'$'}name"}}}]"""
        assertTrue(guard(json).allowed)
    }

    // ---- Row cap ----

    @Test fun `lowers an excessive literal limit`() {
        val v = guard("""[{"${'$'}match": {}}, {"${'$'}limit": 999999}]""", MongoGuardPolicy(maxRows = 100))
        assertTrue(v.allowed)
        assertTrue(v.loweredLimit)
    }

    @Test fun `does not touch a limit already within policy`() {
        val v = guard("""[{"${'$'}match": {}}, {"${'$'}limit": 10}]""", MongoGuardPolicy(maxRows = 1000))
        assertTrue(v.allowed)
        assertFalse(v.autoLimited)
        assertFalse(v.loweredLimit)
    }

    @Test fun `an earlier limit inside a lookup sub-pipeline does not count as the final cap`() {
        val v = guard(
            """[{"${'$'}lookup": {"from": "orders", "as": "o", "pipeline": [{"${'$'}limit": 999999}]}}]""",
            MongoGuardPolicy(maxRows = 100),
        )
        assertTrue(v.allowed)
        assertTrue("expected the OUTER pipeline to still get an auto-appended cap", v.autoLimited)
    }

    // ---- Collection reference collection ----

    @Test fun `collects referenced collections from lookup and unionWith`() {
        val json = """
            [
                {"${'$'}lookup": {"from": "orders", "as": "o", "pipeline": []}},
                {"${'$'}unionWith": {"coll": "archive"}}
            ]
        """.trimIndent()
        val v = guard(json)
        assertTrue(v.allowed)
        assertEquals(setOf("orders", "archive"), v.collections.toSet())
    }

    @Test fun `collects the referenced collection from graphLookup`() {
        val json = """[{"${'$'}graphLookup": {"from": "employees", "startWith": "${'$'}reportsTo", "connectFromField": "reportsTo", "connectToField": "_id", "as": "hierarchy"}}]"""
        val v = guard(json)
        assertTrue(v.allowed)
        assertEquals(setOf("employees"), v.collections.toSet())
    }

    @Test fun `collects the referenced collection from the string form of unionWith`() {
        val v = guard("""[{"${'$'}unionWith": "archive"}]""")
        assertTrue(v.allowed)
        assertEquals(setOf("archive"), v.collections.toSet())
    }

    // ---- Stage shape ----

    @Test fun `blocks a non-document stage hidden inside a lookup sub-pipeline`() {
        // A top-level stage array is guaranteed to be Documents by the parser's
        // own cast, but a NESTED pipeline (lookup/unionWith/facet) is not; this
        // is the only path that actually reaches the `invalid_stage` check.
        val json = """[{"${'$'}lookup": {"from": "orders", "as": "o", "pipeline": [1]}}]"""
        val v = guard(json)
        assertFalse(v.allowed)
        assertEquals("invalid_stage", v.ruleId)
    }

    // ---- Logical maxDepth violation (distinct from the parser StackOverflowError safety net above) ----

    @Test fun `blocks a filter nested past maxDepth without ever overflowing the stack`() {
        val policy = MongoGuardPolicy(maxDepth = 400)
        var value = "1"
        repeat(420) { value = """{"a": $value}""" }
        val json = """[{"${'$'}match": $value}]"""
        val v = guard(json, policy)
        assertFalse(v.allowed)
        assertEquals("too_deep", v.ruleId)
    }
}
