package com.rahulmahadik.asksql.ide.model

/** Core's `GuardPolicy` minus the `mode` field: the read-only floor is immovable, there is no read-write mode. */
data class GuardPolicy(
    val maxRows: Int = 1000,
    val denyFunctions: Set<String> = emptySet(),
    val allowFileFunctions: Boolean = false,
    val maxSqlLength: Int = 100_000,
    /** Generic walk-depth (objects + arrays), not statement nesting: long AND chains legitimately reach ~200. */
    val maxDepth: Int = 400,
) {
    companion object {
        val DEFAULT = GuardPolicy()
    }
}

/** Result of validating (and possibly rewriting) one SQL statement; disallowed SQL returns a verdict, never throws. */
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
