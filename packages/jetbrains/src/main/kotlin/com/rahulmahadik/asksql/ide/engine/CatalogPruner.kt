package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.RoutineKind
import com.rahulmahadik.asksql.ide.model.RoutineVolatility
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import com.rahulmahadik.asksql.ide.model.TableSource
import kotlin.math.ceil
import kotlin.math.max

/**
 * Schema-catalog prompt formatting and deterministic pruning, ported byte-identical
 * from core's `catalog.ts`. `schemaText` must match `@asksql/core` line for line (see `PromptParityTest`).
 */
object CatalogPruner {

    private const val VALUE_SAMPLE_MAX_DISTINCT = 24
    private const val VALUE_SAMPLE_CAP = 80
    private const val COMMENT_CAP = 200

    /** How many foreign-key hops to walk out from a term-matched table, so a chain of joins reaches tables that match no search term themselves. */
    private const val FK_CLOSURE_HOPS = 2

    enum class Strategy { NONE, TERM_MATCH_FK_CLOSURE, BUDGET_TRIM }

    data class PrunerSettings(val maxTables: Int = 40, val maxSchemaTokens: Int = 5000)

    data class PruneResult(
        val catalog: SchemaCatalog,
        val schemaText: String,
        val dropped: Int,
        val strategy: Strategy,
    )

    /** Cheap token estimate (~4 chars per token) for budget decisions only. */
    fun estimateTokens(text: String): Int = ceil(text.length / 4.0).toInt()

    private fun sanitizeComment(comment: String?): String? {
        if (comment.isNullOrBlank()) return null
        val flat = comment.replace(Regex("""\s+"""), " ").trim()
        if (flat.isEmpty()) return null
        return if (flat.length > COMMENT_CAP) "${flat.take(COMMENT_CAP)}..." else flat
    }

    /**
     * Sample/enum values come from live data, unlike comments, so they aren't guaranteed
     * short or whitespace-free. Flattened, capped, and `|` replaced since it's the join separator.
     */
    private fun sanitizeValue(value: String): String {
        val flat = value.replace(Regex("""\s+"""), " ").replace("|", "/").trim()
        return if (flat.length > VALUE_SAMPLE_CAP) "${flat.take(VALUE_SAMPLE_CAP)}..." else flat
    }

    private fun qualifiedName(t: TableInfo, multiSchema: Boolean): String =
        if (multiSchema && t.schema != null) "${t.schema}.${t.name}" else t.name

    fun formatCatalogForPrompt(catalog: SchemaCatalog): String {
        val multiSchema = catalog.schemas.size > 1
        val lines = mutableListOf<String>()

        for (t in catalog.tables) {
            if (t.partitionOf != null) continue // collapsed to parent
            val head = when (t.kind) {
                TableKind.VIEW -> "VIEW"
                TableKind.MATERIALIZED_VIEW -> "MATERIALIZED VIEW"
                TableKind.TABLE -> "TABLE"
            }
            val comment = sanitizeComment(t.comment)
            val est = t.rowEstimate?.takeIf { it >= 0 }?.let { " [~${it} rows]" } ?: ""
            lines += "$head ${qualifiedName(t, multiSchema)}$est${if (comment != null) " -- $comment" else ""}${if (t.source == TableSource.FILE) " [from uploaded file]" else ""}"
            for (c in t.columns) {
                val bits = mutableListOf(" ${c.name} ${c.dbType}")
                if (t.primaryKey.contains(c.name)) bits += "PK"
                val fk = t.foreignKeys.firstOrNull { it.columns.contains(c.name) }
                if (fk != null) bits += "FK->${if (fk.refSchema != null) "${fk.refSchema}." else ""}${fk.refTable}.${fk.refColumns.joinToString(",")}"
                if (!c.nullable) bits += "NOT NULL"
                if (c.enumValues.isNotEmpty()) {
                    bits += "values: ${c.enumValues.take(VALUE_SAMPLE_MAX_DISTINCT).joinToString("|") { sanitizeValue(it) }}"
                } else if (c.sampledValues.isNotEmpty()) {
                    bits += "sample values: ${c.sampledValues.take(VALUE_SAMPLE_MAX_DISTINCT).joinToString("|") { sanitizeValue(it) }}"
                }
                val colComment = sanitizeComment(c.comment)
                if (colComment != null) bits += "-- $colComment"
                lines += bits.joinToString(" ")
            }
        }

        if (catalog.enums.isNotEmpty()) {
            lines += "ENUM TYPES:"
            for (e in catalog.enums) lines += " ${e.name}: ${e.values.take(32).joinToString("|") { sanitizeValue(it) }}"
        }

        val callable = catalog.routines.filter {
            it.kind == RoutineKind.FUNCTION && (it.volatility == RoutineVolatility.IMMUTABLE || it.volatility == RoutineVolatility.STABLE)
        }
        if (callable.isNotEmpty()) {
            lines += "CALLABLE READ-ONLY FUNCTIONS (safe to use in SELECT; call by the exact name shown):"
            for (r in callable.take(40)) {
                val fnName = if (multiSchema && r.schema != null) "${r.schema}.${r.name}" else r.name
                lines += " $fnName(${r.args})${if (r.returns != null) " -> ${r.returns}" else ""}"
            }
        }

        val edges = joinGraph(catalog)
        if (edges.isNotEmpty()) {
            lines += "RELATIONSHIPS (join paths):"
            for (e in edges.take(200)) lines += " $e"
        }

        return lines.joinToString("\n")
    }

    fun joinGraph(catalog: SchemaCatalog): List<String> {
        val multiSchema = catalog.schemas.size > 1
        val edges = mutableListOf<String>()
        val declared = mutableSetOf<String>()
        for (t in catalog.tables) {
            for (fk in t.foreignKeys) {
                edges += "${qualifiedName(t, multiSchema)}.${fk.columns.joinToString(",")} = ${if (fk.refSchema != null && multiSchema) "${fk.refSchema}." else ""}${fk.refTable}.${fk.refColumns.joinToString(",")}"
                declared += "${t.name.lowercase()}.${(fk.columns.firstOrNull() ?: "").lowercase()}"
            }
        }
        // Many real databases (esp. MySQL apps) declare few or no FK constraints, so the
        // declared graph is near-empty. Infer relationships from `<name>_id` / `<name>Id`
        // columns that point at a table whose name matches - conservative (a matching table
        // must exist), and marked so the model treats them as likely, not guaranteed.
        edges += inferredRelationships(catalog, declared, multiSchema)
        return edges
    }

    private fun singularOf(name: String): String =
        when {
            name.endsWith("ies") -> "${name.dropLast(3)}y"
            name.endsWith("ses") -> name.dropLast(2)
            name.endsWith("s") -> name.dropLast(1)
            else -> name
        }

    /** FK-column base name, e.g. "client" from "client_id" or "clientId"; null if not a *_id column. */
    private fun fkBase(column: String): String? {
        val m = Regex("""^(.+?)_?id$""", RegexOption.IGNORE_CASE).find(column) ?: return null
        val base = m.groupValues[1].replace(Regex("""([a-z0-9])([A-Z])"""), "$1_$2").lowercase() // camelCase -> snake
        return if (base.isNotEmpty()) base else null
    }

    /** Naming-convention relationships (`<table>_id` -> that table), skipping ones already declared as FKs. */
    private fun inferredRelationships(catalog: SchemaCatalog, declared: Set<String>, multiSchema: Boolean): List<String> {
        // Index every table by its lowercase name and its singular form, so `client_id` finds `clients`.
        val byName = mutableMapOf<String, TableInfo>()
        for (t in catalog.tables) {
            for (key in listOf(t.name.lowercase(), singularOf(t.name.lowercase()))) {
                if (!byName.containsKey(key)) byName[key] = t
            }
        }
        val out = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        for (t in catalog.tables) {
            for (c in t.columns) {
                val base = fkBase(c.name) ?: continue
                if (base == "i") continue // "id" itself -> base "" skipped above; guard stray
                if (declared.contains("${t.name.lowercase()}.${c.name.lowercase()}")) continue
                // Try the whole base, then its last underscore-segment (e.g. group_appointment -> appointment).
                val target = byName[base] ?: byName[base.substringAfterLast('_')] ?: continue
                if (target.name.lowercase() == t.name.lowercase()) continue
                val pk = target.primaryKey.firstOrNull() ?: "id"
                val edge = "${qualifiedName(t, multiSchema)}.${c.name} ~ ${qualifiedName(target, multiSchema)}.$pk  [inferred from naming]"
                if (seen.contains(edge)) continue
                seen += edge
                out += edge
            }
        }
        return out
    }

    private val STOPWORDS = setOf(
        "the", "a", "an", "of", "in", "on", "for", "to", "by", "and", "or", "with",
        "show", "me", "all", "list", "get", "give", "what", "which", "how", "many",
        "much", "per", "top", "last", "first", "is", "are", "was", "were", "from",
    )

    private fun terms(question: String): List<String> =
        question.lowercase()
            .split(Regex("""[^a-z0-9_]+"""))
            .filter { it.length > 2 && !STOPWORDS.contains(it) }
            .map { if (it.endsWith("s") && it.length > 3) it.dropLast(1) else it }

    /** Splits snake_case and camelCase identifiers into lowercase words, so "customer_id"/"productName" match the term "customer"/"product". */
    private fun tokenizeIdentifier(raw: String): List<String> =
        raw.split(Regex("""[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])"""))
            .map { it.lowercase() }
            .filter { it.length > 1 }

    /** Word-level scoring beats raw substring: a term matching a whole word in a name ranks above an incidental substring, cutting false positives on large schemas. */
    private fun scoreTable(t: TableInfo, qTerms: List<String>): Int {
        val name = t.name.lowercase()
        val nameTokens = tokenizeIdentifier(t.name).toSet()
        val columnTokens = t.columns.flatMap { tokenizeIdentifier(it.name) }.toSet()
        val commentHay = (listOf(t.comment ?: "") + t.columns.map { it.comment ?: "" }).joinToString(" ").lowercase()
        var score = 0
        for (term in qTerms) {
            val plural = "${term}s"
            score += when {
                name == term || name == plural -> 6
                nameTokens.contains(term) || nameTokens.contains(plural) -> 5
                name.contains(term) -> 4
                columnTokens.contains(term) || columnTokens.contains(plural) -> 2
                commentHay.contains(term) -> 1
                else -> 0
            }
        }
        return score
    }

    private fun estimateTableTokens(t: TableInfo): Int {
        var chars = t.name.length + (t.schema?.length ?: 0) + (t.comment?.length ?: 0) + 24
        for (c in t.columns) {
            chars += c.name.length + c.dbType.length + (c.comment?.length ?: 0) + 24
            // Sample/enum values are capped in formatCatalogForPrompt too; must be counted
            // here so a column with many values isn't budgeted as if it had none.
            val values = if (c.enumValues.isNotEmpty()) c.enumValues else c.sampledValues
            for (v in values.take(VALUE_SAMPLE_MAX_DISTINCT)) chars += minOf(v.length, VALUE_SAMPLE_CAP) + 1
        }
        chars += t.foreignKeys.size * 40
        return ceil(chars / 4.0).toInt()
    }

    fun pruneCatalog(catalog: SchemaCatalog, question: String, settings: PrunerSettings = PrunerSettings()): PruneResult {
        val maxTables = settings.maxTables
        val maxSchemaTokens = settings.maxSchemaTokens
        val all = catalog.tables.filter { it.partitionOf == null }

        // Skip formatting (real work on large schemas) when the table count alone already
        // means pruning is needed; this branch only fires when it would have returned anyway.
        if (all.size <= maxTables) {
            val fullText = formatCatalogForPrompt(catalog.copy(tables = all))
            if (estimateTokens(fullText) <= maxSchemaTokens) {
                return PruneResult(catalog.copy(tables = all), fullText, catalog.tables.size - all.size, Strategy.NONE)
            }
        }

        val qTerms = terms(question)
        val scored = all.map { it to scoreTable(it, qTerms) }.sortedByDescending { it.second }

        val seeds = scored.filter { it.second > 0 }.map { it.first }
        fun key(schema: String?, name: String) = "${schema ?: ""}.$name"

        val byName = mutableMapOf<String, TableInfo>()
        for (t in all) {
            byName[key(t.schema, t.name)] = t
            byName[".${t.name}"] = t
        }

        // Undirected FK adjacency so a join chain A-B-C-D is reachable from a seed at either end.
        val neighbors = mutableMapOf<String, MutableSet<String>>()
        for (t in all) {
            val tk = key(t.schema, t.name)
            for (fk in t.foreignKeys) {
                val ref = byName[key(fk.refSchema, fk.refTable)] ?: byName[".${fk.refTable}"] ?: continue
                val rk = key(ref.schema, ref.name)
                neighbors.getOrPut(tk) { mutableSetOf() }.add(rk)
                neighbors.getOrPut(rk) { mutableSetOf() }.add(tk)
            }
        }

        // BFS out from the seeds up to FK_CLOSURE_HOPS, so multi-join questions get the whole path, bounded by maxTables.
        val expanded = linkedSetOf<String>()
        var frontier = seeds.map { key(it.schema, it.name) }.toSet()
        expanded += frontier
        repeat(FK_CLOSURE_HOPS) {
            if (expanded.size < maxTables) {
                val next = frontier.flatMap { neighbors[it].orEmpty() }.toSet() - expanded
                expanded += next
                frontier = next
            }
        }

        var candidate = scored.filter { expanded.contains(key(it.first.schema, it.first.name)) || it.second > 0 }.map { it.first }
        if (candidate.isEmpty()) candidate = scored.take(maxTables).map { it.first }

        val order = scored.mapIndexed { i, s -> key(s.first.schema, s.first.name) to i }.toMap()
        candidate = candidate.sortedBy { order[key(it.schema, it.name)] ?: 0 }

        val perTableBudget = max(500, maxSchemaTokens - 400)
        val kept = mutableListOf<TableInfo>()
        var used = 0
        for (t in candidate) {
            if (kept.size >= maxTables) break
            val cost = estimateTableTokens(t)
            if (kept.size >= 1 && used + cost > perTableBudget) break
            kept += t
            used += cost
        }

        val prunedCatalog = catalog.copy(tables = kept)
        return PruneResult(
            catalog = prunedCatalog,
            schemaText = formatCatalogForPrompt(prunedCatalog),
            dropped = all.size - kept.size,
            strategy = if (kept.size < all.size) Strategy.TERM_MATCH_FK_CLOSURE else Strategy.BUDGET_TRIM,
        )
    }
}
