package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.MongoGuardPolicy
import com.rahulmahadik.asksql.ide.model.MongoGuardVerdict
import org.bson.Document
import org.bson.json.JsonParseException

/**
 * The MongoDB security boundary, validating a JSON pipeline as [SqlGuard] validates a SQL AST.
 * MongoDB has no session-level read-only flag to arm, so this guard is the only floor.
 */
object MongoGuard {

    /** Classic ReDoS shape: a quantified group wrapping another quantifier, e.g. `(a+)+`. Heuristic, not a full analysis. */
    private val NESTED_QUANTIFIER = Regex("""\([^()]*[+*][^()]*\)[+*]""")

    /** Aggregation operators carrying a regex under a `regex` field. */
    private val REGEX_OPERATORS = setOf("\$regexMatch", "\$regexFind", "\$regexFindAll")

    /** Accumulators building an unbounded array; a `$group` using one needs an earlier `$limit`/`$sample`. */
    private val ARRAY_ACCUMULATORS = setOf("\$push", "\$addToSet")

    /** Re-parses an already-[guard]ed pipeline's [MongoGuardVerdict.pipelineJson] for execution; the single choke point so execution never reads a second, possibly-divergent parse. */
    fun parsePipeline(pipelineJson: String): List<Document> =
        Document.parse("{\"p\": ${pipelineJson.trim()}}").getList("p", Document::class.java)

    fun guard(pipelineJson: String, policy: MongoGuardPolicy = MongoGuardPolicy()): MongoGuardVerdict {
        val trimmed = pipelineJson.trim()
        if (trimmed.isEmpty()) return blocked(pipelineJson, "empty", "The pipeline is empty.")

        val stages: MutableList<Document> = try {
            // The BSON extended-JSON parser only parses a single top-level object, not a bare
            // array; wrapping it is the standard trick for parsing a raw JSON array with this API.
            Document.parse("{\"p\": $trimmed}").getList("p", Document::class.java)
        } catch (e: JsonParseException) {
            return blocked(pipelineJson, "parse_failed", "The pipeline could not be parsed as a JSON array of stage documents.")
        } catch (e: StackOverflowError) {
            // Pathologically deep nesting overflows the parser's own stack before walkPipeline's depth check ever runs.
            return blocked(pipelineJson, "too_deep", "The pipeline is nested too deeply to verify safely.")
        } catch (e: Exception) {
            return blocked(pipelineJson, "parse_failed", "The pipeline could not be parsed as a JSON array of stage documents.")
        }

        if (stages.isEmpty()) return blocked(pipelineJson, "empty", "The pipeline has no stages.")

        val collections = mutableListOf<String>()
        val violation = try {
            walkPipeline(stages, policy, depth = 0, collections)
        } catch (e: StackOverflowError) {
            Violation("too_deep", "The pipeline is nested too deeply to verify safely.")
        }
        if (violation != null) return blocked(pipelineJson, violation.ruleId, violation.reason)

        var autoLimited = false
        var loweredLimit = false
        when (val status = inspectLimit(stages, policy.maxRows)) {
            is LimitStatus.None -> {
                stages.add(Document(MongoDenyLists.LIMIT_STAGE, policy.maxRows.toLong()))
                autoLimited = true
            }
            is LimitStatus.High -> {
                stages[stages.size - 1] = Document(MongoDenyLists.LIMIT_STAGE, policy.maxRows.toLong())
                loweredLimit = true
            }
            LimitStatus.Ok -> Unit
        }

        return MongoGuardVerdict(
            allowed = true,
            // A bare JSON array, matching the shape callers pass back in. Document("p",
            // stages).toJson() would wrap it as {"p": [...]}, which every consumer
            // (parsePipeline, guard() re-called) parses as a stage array, not a wrapper.
            pipelineJson = stages.joinToString(",", prefix = "[", postfix = "]") { it.toJson() },
            autoLimited = autoLimited,
            loweredLimit = loweredLimit,
            collections = collections.distinct(),
        )
    }

    private fun blocked(sql: String, ruleId: String, reason: String) =
        MongoGuardVerdict(allowed = false, pipelineJson = sql, ruleId = ruleId, reason = reason)

    private data class Violation(val ruleId: String, val reason: String)

    private fun walkPipeline(stages: List<*>, policy: MongoGuardPolicy, depth: Int, collections: MutableList<String>): Violation? {
        if (depth > policy.maxDepth) return Violation("too_deep", "The pipeline is nested too deeply to verify safely.")

        // A $push/$addToSet with no earlier bound collects the whole collection into one document,
        // sliding past the row cap; require a preceding $limit/$sample.
        var bounded = false
        for (stage in stages) {
            if (stage !is Document) {
                return Violation("invalid_stage", "Every pipeline stage must be a single JSON object.")
            }
            if (stage.size != 1) {
                return Violation("invalid_stage", "Every pipeline stage must have exactly one operator key.")
            }
            val stageName = stage.keys.first()
            if (stageName !in MongoDenyLists.ALLOWED_STAGES) {
                return Violation("stage_denied:$stageName", "The stage $stageName is not allowed.")
            }

            walkForDeniedOperators(stage, policy, depth + 1)?.let { return it }
            if (stageName == "\$group" && !bounded && hasArrayAccumulator(stage["\$group"])) {
                return Violation("unbounded_accumulator", "A \$push/\$addToSet collects an unbounded array; add a \$limit before the \$group.")
            }
            if (boundsRowCount(stageName, stage[stageName])) bounded = true
            collectCollectionRefs(stageName, stage[stageName], collections)

            when (stageName) {
                MongoDenyLists.LOOKUP_STAGE -> {
                    val body = stage[stageName] as? Document
                    val nested = body?.get("pipeline")
                    if (nested is List<*>) {
                        walkPipeline(nested, policy, depth + 1, collections)?.let { return it }
                    }
                }
                MongoDenyLists.UNION_WITH_STAGE -> {
                    val body = stage[stageName]
                    val nested = (body as? Document)?.get("pipeline")
                    if (nested is List<*>) {
                        walkPipeline(nested, policy, depth + 1, collections)?.let { return it }
                    }
                }
                MongoDenyLists.FACET_STAGE -> {
                    val body = stage[stageName] as? Document
                    body?.values?.forEach { branch ->
                        if (branch is List<*>) {
                            walkPipeline(branch, policy, depth + 1, collections)?.let { return it }
                        }
                    }
                }
            }
        }
        return null
    }

    /** True if a $group spec accumulates into an array via $push/$addToSet anywhere. */
    private fun hasArrayAccumulator(spec: Any?): Boolean = when (spec) {
        is Document -> spec.any { (k, v) -> k in ARRAY_ACCUMULATORS || hasArrayAccumulator(v) }
        is List<*> -> spec.any { hasArrayAccumulator(it) }
        else -> false
    }

    /** A $limit or sized $sample stage bounds how many documents later stages can accumulate. */
    private fun boundsRowCount(name: String, spec: Any?): Boolean = when (name) {
        MongoDenyLists.LIMIT_STAGE -> spec is Number
        "\$sample" -> spec is Document && spec["size"] is Number
        else -> false
    }

    private fun collectCollectionRefs(stageName: String, body: Any?, collections: MutableList<String>) {
        when (stageName) {
            MongoDenyLists.LOOKUP_STAGE, "\$graphLookup" -> (body as? Document)?.getString("from")?.let { collections += it }
            MongoDenyLists.UNION_WITH_STAGE -> when (body) {
                is String -> collections += body
                is Document -> body.getString("coll")?.let { collections += it }
                else -> Unit
            }
        }
    }

    /**
     * Scans every key in the entire value tree for a denied operator: `$expr` can embed `$function`,
     * `$redact` can embed either, and no exhaustive "safe positions" list exists to allowlist instead.
     */
    private fun walkForDeniedOperators(value: Any?, policy: MongoGuardPolicy, depth: Int): Violation? {
        if (depth > policy.maxDepth) return Violation("too_deep", "The pipeline is nested too deeply to verify safely.")
        // An EJSON $regularExpression parses to a BsonRegularExpression value (not a $regex key).
        if (value is org.bson.BsonRegularExpression) return checkPattern(value.pattern, policy)
        when (value) {
            is Document -> {
                for ((key, v) in value) {
                    if (key in MongoDenyLists.DENIED_OPERATORS_ANYWHERE) {
                        return Violation("operator_denied:$key", "The operator $key is not allowed.")
                    }
                    // Bound every regex-pattern carrier, not just a `$regex` string: `$regex` in any
                    // shape, and the `regex` field of $regexMatch/$regexFind/$regexFindAll.
                    if (key == "\$regex") {
                        checkPattern(regexPatternOf(v), policy)?.let { return it }
                    } else if (key in REGEX_OPERATORS && v is Document && v.containsKey("regex")) {
                        checkPattern(regexPatternOf(v["regex"]), policy)?.let { return it }
                    }
                    walkForDeniedOperators(v, policy, depth + 1)?.let { return it }
                }
            }
            is List<*> -> for (item in value) walkForDeniedOperators(item, policy, depth + 1)?.let { return it }
            else -> Unit
        }
        return null
    }

    /** The inspectable pattern text from a regex carrier, or null when it cannot be read (fail closed). */
    private fun regexPatternOf(v: Any?): String? = when (v) {
        is String -> v
        is org.bson.BsonRegularExpression -> v.pattern
        is Document -> (v["\$regularExpression"] as? Document)?.get("pattern") as? String ?: (v["pattern"] as? String)
        else -> null
    }

    /** Length + catastrophic-backtracking checks on a regex pattern; null pattern (opaque) fails closed. */
    private fun checkPattern(pattern: String?, policy: MongoGuardPolicy): Violation? {
        if (pattern == null) return Violation("regex_opaque", "A regular expression in the query could not be inspected for safety.")
        // Length alone isn't real ReDoS protection (e.g. (a+)+$ is 6 chars); paired with the nested-quantifier check.
        if (pattern.length > policy.maxRegexPatternLength) return Violation("regex_too_long", "The regular expression pattern is too long to run safely.")
        if (NESTED_QUANTIFIER.containsMatchIn(pattern)) {
            return Violation("regex_unsafe", "The regular expression pattern is not allowed (nested repetition is a denial-of-service risk).")
        }
        return null
    }

    private sealed interface LimitStatus {
        data object None : LimitStatus
        data object Ok : LimitStatus
        data object High : LimitStatus
    }

    /** Only the pipeline's FINAL stage governs the actual output row count; an earlier `$limit` (e.g. inside a `$lookup` sub-pipeline) caps something else entirely. */
    private fun inspectLimit(stages: List<Document>, maxRows: Int): LimitStatus {
        val last = stages.lastOrNull() ?: return LimitStatus.None
        if (last.size != 1 || !last.containsKey(MongoDenyLists.LIMIT_STAGE)) return LimitStatus.None
        val value = (last[MongoDenyLists.LIMIT_STAGE] as? Number)?.toLong() ?: return LimitStatus.None
        return if (value > maxRows) LimitStatus.High else LimitStatus.Ok
    }
}
