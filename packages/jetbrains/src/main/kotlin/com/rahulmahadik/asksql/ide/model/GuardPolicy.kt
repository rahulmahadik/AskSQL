package com.rahulmahadik.asksql.ide.model

/**
 * The read-only floor is immovable in v1; there is no "read-write" mode.
 * Core's `GuardPolicy`, minus the `mode` field (core keeps it only to reject non-"read-only" values).
 */
data class GuardPolicy(
    val maxRows: Int = 1000,
    val denyFunctions: Set<String> = emptySet(),
    val allowFileFunctions: Boolean = false,
    val maxSqlLength: Int = 100_000,
    /**
     * Generic walk-depth (objects + arrays), not statement nesting: long AND
     * chains legitimately reach ~200. 400 still blocks pathological nesting.
     */
    val maxDepth: Int = 400,
) {
    companion object {
        val DEFAULT = GuardPolicy()
    }
}

/**
 * Result of validating (and possibly rewriting) one SQL statement. The guard
 * never throws for disallowed SQL; it returns a verdict.
 */
data class GuardVerdict(
    val allowed: Boolean,
    val sql: String,
    val ruleId: String? = null,
    val reason: String? = null,
    val warnings: List<String> = emptyList(),
    val autoLimited: Boolean = false,
    val loweredLimit: Boolean = false,
    /** Base relations referenced by the statement, reused by the hallucination floor to avoid a second parse. */
    val tables: List<String> = emptyList(),
)
