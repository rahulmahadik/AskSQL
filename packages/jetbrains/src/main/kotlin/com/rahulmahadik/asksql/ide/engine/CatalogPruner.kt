package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
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

    /** How many foreign-key hops to walk out from a term-matched table. */
    private const val FK_CLOSURE_HOPS = 2

    enum class Strategy { NONE, TERM_MATCH_FK_CLOSURE, BUDGET_TRIM }

    /**
     * [maxTables] guards the full render from a pathological schema; the token budget decides what is
     * actually sent. Matches packages/core/src/catalog.ts.
     */
    data class PrunerSettings(val maxTables: Int = 200, val maxSchemaTokens: Int = 6000)

    data class PruneResult(
        val catalog: SchemaCatalog,
        val schemaText: String,
        val dropped: Int,
        val strategy: Strategy,
    )

    /** Cheap token estimate (~4 chars per token) for budget decisions only. */
    fun estimateTokens(text: String): Int = ceil(text.length / 4.0).toInt()

    // Hoisted: these run once per comment/sample value/column across the whole catalog, and an
    // inline Regex(...) recompiles its Pattern on every call.
    private val WHITESPACE_RUN_RE = Regex("""\s+""")
    private val FK_BASE_RE = Regex("""^(.+?)_?id$""", RegexOption.IGNORE_CASE)
    private val CAMEL_BOUNDARY_RE = Regex("""([a-z0-9])([A-Z])""")
    private val NON_TERM_RE = Regex("""[^a-z0-9_]+""")
    private val IDENTIFIER_SPLIT_RE = Regex("""[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])""")

    private fun sanitizeComment(comment: String?): String? {
        if (comment.isNullOrBlank()) return null
        val flat = comment.replace(WHITESPACE_RUN_RE, " ").trim()
        if (flat.isEmpty()) return null
        return if (flat.length > COMMENT_CAP) "${flat.take(COMMENT_CAP)}..." else flat
    }

    /** Flattens and caps a live-data sample value, replacing `|` (the join separator). */
    private fun sanitizeValue(value: String): String {
        val flat = value.replace(WHITESPACE_RUN_RE, " ").replace("|", "/").trim()
        return if (flat.length > VALUE_SAMPLE_CAP) flat.take(VALUE_SAMPLE_CAP) else flat
    }

    /** A name that can be written without quotes; anything else is rendered quoted. */
    private val PLAIN_IDENTIFIER_RE = Regex("""^[A-Za-z_][A-Za-z0-9_]*$""")

    /**
     * The quote character for prompt text. Not [com.rahulmahadik.asksql.ide.model.Dialects.of],
     * which throws for MongoDB; this formatter renders the document catalog too.
     */
    private fun quoteCharFor(engine: EngineKind): Char = if (engine == EngineKind.MYSQL) '`' else '"'

    
    /**
     * True when the engine would not read the bare name back as itself: an unquoted identifier
     * folds case - PostgreSQL to lower, Oracle to upper.
     */
    internal fun needsQuoting(name: String, engine: EngineKind): Boolean {
        if (!PLAIN_IDENTIFIER_RE.matches(name)) return true
        if (name.lowercase() in SqlKeywords.reservedWordsFor(engine.name)) return true
        return when (engine) {
            EngineKind.ORACLE -> name != name.uppercase()
            // MySQL, SQLite and DuckDB match identifiers case-insensitively.
            EngineKind.MYSQL, EngineKind.SQLITE, EngineKind.DUCKDB -> false
            else -> name != name.lowercase()
        }
    }

    private fun promptIdentifier(name: String, quote: Char, engine: EngineKind): String {
        if (!needsQuoting(name, engine)) return name
        // Doubling is how every supported engine escapes its own quote character in an identifier.
        return "$quote${name.replace(quote.toString(), "$quote$quote")}$quote"
    }

    private fun qualifiedName(t: TableInfo, multiSchema: Boolean, quote: Char, engine: EngineKind): String {
        val name = promptIdentifier(t.name, quote, engine)
        return if (multiSchema && t.schema != null) "${promptIdentifier(t.schema, quote, engine)}.$name" else name
    }

    /** Bounds so a large catalog cannot crowd out the tables themselves; matches core. */
    /** Never trim a table below this many columns. */
    private const val MIN_COLUMNS_KEPT = 12

    private const val MAX_INDEXES_PER_TABLE = 8
    private const val MAX_OBJECTS = 30
    /** Max join paths rendered; a wide schema has far more edges than the model can use. */
    private const val MAX_EDGES = 200
    /** Max callable functions rendered. */
    private const val MAX_FUNCTIONS = 40

    /**
     * Marks a list the renderer cut short. A silent cut reads as the complete set, so the model treats
     * a name it was never shown as one that does not exist. Matches packages/core/src/catalog.ts.
     */
    private fun andMore(total: Int, shown: Int): String =
        if (total > shown) " (and ${total - shown} more not shown)" else ""

    fun formatCatalogForPrompt(catalog: SchemaCatalog): String {
        val multiSchema = catalog.schemas.size > 1
        val quote = quoteCharFor(catalog.engine)
        val engine = catalog.engine
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
            lines += "$head ${qualifiedName(t, multiSchema, quote, engine)}$est${if (comment != null) " -- $comment" else ""}${if (t.source == TableSource.FILE) " [from uploaded file]" else ""}"
            for (c in t.columns) {
                val bits = mutableListOf(" ${promptIdentifier(c.name, quote, engine)} ${c.dbType}")
                if (t.primaryKey.contains(c.name)) bits += "PK"
                val fk = t.foreignKeys.firstOrNull { it.columns.contains(c.name) }
                if (fk != null) {
                    val target = if (fk.refSchema != null) "${promptIdentifier(fk.refSchema, quote, engine)}." else ""
                    bits += "FK->$target${promptIdentifier(fk.refTable, quote, engine)}.${fk.refColumns.joinToString(",") { promptIdentifier(it, quote, engine) }}"
                }
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
            // Indexes are what a "should I add an index?" or "why is this slow?" question is about.
            if (t.indexes.isNotEmpty()) {
                val shown = t.indexes.take(MAX_INDEXES_PER_TABLE).joinToString(", ") { i ->
                    "${i.name}(${i.columns.joinToString(",")})" +
                        (if (i.unique) " UNIQUE" else "") +
                        (if (i.predicate != null) " WHERE ..." else "")
                }
                lines += " INDEXES: $shown"
            }
        }

        if (catalog.triggers.isNotEmpty()) {
            lines += "TRIGGERS:${andMore(catalog.triggers.size, MAX_OBJECTS)}"
            for (tr in catalog.triggers.take(MAX_OBJECTS)) {
                val on = if (tr.schema != null) "${tr.schema}.${tr.table}" else tr.table
                lines += " ${tr.name} ${tr.timing} ${tr.events.joinToString("/")} ON $on" + if (tr.enabled) "" else " [disabled]"
            }
        }

        val procedures = catalog.routines.filter { it.kind == RoutineKind.PROCEDURE }
        if (procedures.isNotEmpty()) {
            // Listed so "what procedures exist" can be answered; never offered as something to call.
            lines += "STORED PROCEDURES (reference only - NEVER call these; a read-only query cannot invoke them):${andMore(procedures.size, MAX_OBJECTS)}"
            for (r in procedures.take(MAX_OBJECTS)) {
                lines += " ${if (multiSchema && r.schema != null) "${r.schema}.${r.name}" else r.name}(${r.args})"
            }
        }

        if (catalog.sequences.isNotEmpty()) {
            val names = catalog.sequences.take(MAX_OBJECTS)
                .joinToString(", ") { if (multiSchema && it.schema != null) "${it.schema}.${it.name}" else it.name }
            lines += "SEQUENCES: $names${andMore(catalog.sequences.size, MAX_OBJECTS)}"
        }

        if (catalog.enums.isNotEmpty()) {
            lines += "ENUM TYPES:${andMore(catalog.enums.size, MAX_OBJECTS)}"
            for (e in catalog.enums.take(MAX_OBJECTS)) lines += " ${e.name}: ${e.values.take(32).joinToString("|") { sanitizeValue(it) }}"
        }

        val callable = catalog.routines.filter {
            it.kind == RoutineKind.FUNCTION && (it.volatility == RoutineVolatility.IMMUTABLE || it.volatility == RoutineVolatility.STABLE)
        }
        if (callable.isNotEmpty()) {
            lines += "CALLABLE READ-ONLY FUNCTIONS (safe to use in SELECT; call by the exact name shown):${andMore(callable.size, MAX_FUNCTIONS)}"
            for (r in callable.take(MAX_FUNCTIONS)) {
                val fnName = if (multiSchema && r.schema != null) "${r.schema}.${r.name}" else r.name
                lines += " $fnName(${r.args})${if (r.returns != null) " -> ${r.returns}" else ""}"
            }
        }

        val edges = joinGraph(catalog)
        if (edges.isNotEmpty()) {
            lines += "RELATIONSHIPS (join paths):${andMore(edges.size, MAX_EDGES)}"
            for (e in edges.take(MAX_EDGES)) lines += " $e"
        }

        return lines.joinToString("\n")
    }

    fun joinGraph(catalog: SchemaCatalog): List<String> {
        val multiSchema = catalog.schemas.size > 1
        val quote = quoteCharFor(catalog.engine)
        val engine = catalog.engine
        val edges = mutableListOf<String>()
        val declared = mutableSetOf<String>()
        for (t in catalog.tables) {
            for (fk in t.foreignKeys) {
                edges += "${qualifiedName(t, multiSchema, quote, engine)}.${fk.columns.joinToString(",") { promptIdentifier(it, quote, engine) }} = ${if (fk.refSchema != null && multiSchema) "${promptIdentifier(fk.refSchema, quote, engine)}." else ""}${promptIdentifier(fk.refTable, quote, engine)}.${fk.refColumns.joinToString(",") { promptIdentifier(it, quote, engine) }}"
                declared += "${t.name.lowercase()}.${(fk.columns.firstOrNull() ?: "").lowercase()}"
            }
        }
        // Many real databases declare few or no FK constraints, so `<name>_id` / `<name>Id` columns
        // that point at a matching table name are also inferred, marked as likely rather than guaranteed.
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
        val m = FK_BASE_RE.find(column) ?: return null
        val base = m.groupValues[1].replace(CAMEL_BOUNDARY_RE, "$1_$2").lowercase() // camelCase -> snake
        return if (base.isNotEmpty()) base else null
    }

    /** Naming-convention relationships (`<table>_id` -> that table), skipping ones already declared as FKs. */
    private fun inferredRelationships(catalog: SchemaCatalog, declared: Set<String>, multiSchema: Boolean): List<String> {
        val quote = quoteCharFor(catalog.engine)
        val engine = catalog.engine
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
                val edge = "${qualifiedName(t, multiSchema, quote, engine)}.${promptIdentifier(c.name, quote, engine)} ~ ${qualifiedName(target, multiSchema, quote, engine)}.${promptIdentifier(pk, quote, engine)}  [inferred from naming]"
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
            .split(NON_TERM_RE)
            .filter { it.length > 2 && !STOPWORDS.contains(it) }
            .map { if (it.endsWith("s") && it.length > 3) it.dropLast(1) else it }

    /** Splits snake_case and camelCase identifiers into lowercase words, so "customer_id"/"productName" match the term "customer"/"product". */
    private fun tokenizeIdentifier(raw: String): List<String> =
        raw.split(IDENTIFIER_SPLIT_RE)
            .map { it.lowercase() }
            .filter { it.length > 1 }

    /** Word-level scoring: a term matching a whole word in a name ranks above an incidental substring. */
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

    /**
     * Keeps the columns a question is most likely to need when one table alone blows the budget:
     * keys first, then question-term matches, then declaration order. The omitted count is stated.
     */
    private fun trimColumns(
        t: TableInfo,
        qTerms: Set<String>,
        budgetTokens: Int,
        referencedByOthers: Set<String> = emptySet(),
    ): TableInfo {
        if (estimateTableTokens(t) <= budgetTokens || t.columns.size <= MIN_COLUMNS_KEPT) return t
        // Columns another table's FK points at must survive; the prompt and join graph still name them.
        val keyNames = (t.primaryKey + t.foreignKeys.flatMap { it.columns } + referencedByOthers).toSet()
        fun rank(name: String): Int = when {
            keyNames.contains(name) || keyNames.contains(name.lowercase()) -> 0
            qTerms.any { name.lowercase().contains(it) } -> 1
            else -> 2
        }
        val ordered = t.columns.withIndex().sortedWith(compareBy({ rank(it.value.name) }, { it.index }))
        // Indices, not names, so duplicate spreadsheet headers do not all survive together.
        val keptIndices = mutableSetOf<Int>()
        var used = estimateTableTokens(t.copy(columns = emptyList()))
        for ((index, c) in ordered) {
            val cost = ceil(columnChars(c) / 4.0).toInt()
            if (keptIndices.size >= MIN_COLUMNS_KEPT && used + cost > budgetTokens) break
            keptIndices += index
            used += cost
        }
        val omitted = t.columns.size - keptIndices.size
        if (omitted <= 0) return t
        // The marker has to survive the comment cap, so the original comment yields room for it.
        val marker = "[$omitted of ${t.columns.size} columns not shown]"
        val room = COMMENT_CAP - marker.length - 1
        val existing = sanitizeComment(t.comment) ?: ""
        val prefix = if (existing.isNotEmpty() && room > 0) "${existing.take(room)} " else ""
        return t.copy(
            // Restore declaration order so the table still reads like the table.
            columns = t.columns.filterIndexed { i, _ -> keptIndices.contains(i) },
            comment = "$prefix$marker",
        )
    }

    /** One column's rendered size. Shared with [trimColumns] so the trim loop and the estimator charge the same. */
    private fun columnChars(c: ColumnInfo): Int {
        var chars = c.name.length + c.dbType.length + (c.comment?.length ?: 0) + 24
        val values = if (c.enumValues.isNotEmpty()) c.enumValues else c.sampledValues
        for (v in values.take(VALUE_SAMPLE_MAX_DISTINCT)) chars += minOf(v.length, VALUE_SAMPLE_CAP) + 1
        return chars
    }

    private fun estimateTableTokens(t: TableInfo): Int {
        var chars = t.name.length + (t.schema?.length ?: 0) + (t.comment?.length ?: 0) + 24
        for (c in t.columns) chars += columnChars(c)
        chars += t.foreignKeys.size * 40
        // Indexes are rendered too (capped at MAX_INDEXES_PER_TABLE), so budget for them.
        for (i in t.indexes.take(MAX_INDEXES_PER_TABLE)) chars += i.name.length + i.columns.joinToString(",").length + 12
        return ceil(chars / 4.0).toInt()
    }

    fun pruneCatalog(catalog: SchemaCatalog, question: String, settings: PrunerSettings = PrunerSettings()): PruneResult {
        val maxTables = settings.maxTables
        val maxSchemaTokens = settings.maxSchemaTokens
        val all = catalog.tables.filter { it.partitionOf == null }

        // Format only when the table count already fits; formatting a large schema is real work.
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
            if (kept.isEmpty()) {
                // Always kept, charged at most half the budget so siblings still fit.
                kept += t
                used += minOf(cost, perTableBudget / 2)
                continue
            }
            // Skip what does not fit rather than stopping: smaller tables behind it may still have room.
            if (used + cost > perTableBudget) continue
            kept += t
            used += cost
        }

        // Column trimming is a last resort, so it runs only when the rendered schema is still over budget.
        var finalTables: List<TableInfo> = kept
        var text = formatCatalogForPrompt(catalog.copy(tables = kept))
        if (estimateTokens(text) > maxSchemaTokens) {
            val perTableBudgetTokens = maxOf(200, maxSchemaTokens / maxOf(1, kept.size))
            // Built from EVERY table: a referencing table may have been pruned, yet the join graph still names the column.
            val referenced = HashMap<String, MutableSet<String>>()
            for (t in all) {
                for (fk in t.foreignKeys) {
                    val set = referenced.getOrPut(fk.refTable.lowercase()) { mutableSetOf() }
                    for (c in fk.refColumns) set += c.lowercase()
                }
            }
            finalTables = kept.map {
                trimColumns(it, qTerms.toSet(), perTableBudgetTokens, referenced[it.name.lowercase()] ?: emptySet())
            }
            text = formatCatalogForPrompt(catalog.copy(tables = finalTables))
        }
        val prunedCatalog = catalog.copy(tables = finalTables)
        return PruneResult(
            catalog = prunedCatalog,
            schemaText = text,
            dropped = all.size - kept.size,
            // Column trimming is the more severe outcome and the one worth reporting.
            strategy = if (finalTables.indices.any { finalTables[it] !== kept[it] }) Strategy.BUDGET_TRIM else Strategy.TERM_MATCH_FK_CLOSURE,
        )
    }
}
