package com.rahulmahadik.asksql.ide.model

/** MongoDB has no upstream `@asksql/core` counterpart; this policy is original to the plugin. */
data class MongoGuardPolicy(
    val maxRows: Int = 1000,
    /** Object/array walk depth; plays [GuardPolicy.maxDepth]'s role for the Mongo guard. */
    val maxDepth: Int = 400,
    /** Best-effort ReDoS mitigation: a full defense would require analyzing pattern complexity, not just length. */
    val maxRegexPatternLength: Int = 200,
)

/**
 * Result of validating (and possibly rewriting) one aggregation pipeline. Every AskSQL Mongo query
 * is a pipeline (a plain filter is a single `$match` stage), unlike MongoDB's own find()/aggregate() split.
 */
data class MongoGuardVerdict(
    val allowed: Boolean,
    /** The validated (and possibly `$limit`-capped) pipeline, as extended-JSON text. */
    val pipelineJson: String,
    val ruleId: String? = null,
    val reason: String? = null,
    val warnings: List<String> = emptyList(),
    val autoLimited: Boolean = false,
    val loweredLimit: Boolean = false,
    /** Collections referenced via the base `aggregate()` call plus any `$lookup`/`$unionWith`/`$graphLookup`, reused by a hallucination floor the same way [GuardVerdict.tables] is. */
    val collections: List<String> = emptyList(),
)
