package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import net.sf.jsqlparser.expression.ExpressionVisitorAdapter
import net.sf.jsqlparser.parser.CCJSqlParserUtil
import net.sf.jsqlparser.schema.Column
import net.sf.jsqlparser.statement.select.ParenthesedSelect
import net.sf.jsqlparser.statement.select.PlainSelect
import net.sf.jsqlparser.statement.select.Select
import net.sf.jsqlparser.statement.select.SetOperationList
import net.sf.jsqlparser.util.TablesNamesFinder

/**
 * The hallucination floor: catches references to tables/columns absent from the real schema before
 * the query reaches the database, so the repair loop can re-prompt. Fails open on every ambiguity.
 */
object HallucinationChecks {

    data class UnknownColumn(val table: String, val column: String, val available: List<String>)

    private val SYSTEM_SCHEMAS = setOf("information_schema", "pg_catalog", "mysql", "performance_schema", "sys")
    /**
     * The quote characters matter: normalisation may have quoted a CTE named like a catalog column,
     * and a model can quote one itself. An unrecognised CTE reads as a hallucinated table.
     */
    private val CTE_NAME =
        Regex("""["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+as\s*\(""", RegexOption.IGNORE_CASE)
    private val HAS_WITH = Regex("""\bwith\b""", RegexOption.IGNORE_CASE)
    private val SELECT_ALIAS_RE = Regex("""\bas\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?""", RegexOption.IGNORE_CASE)
    private val SET_OPERATION_RE = Regex("""\b(union|intersect|except)\b""", RegexOption.IGNORE_CASE)
    private val SUBQUERY_OPEN_RE = Regex("""\(\s*select\b""", RegexOption.IGNORE_CASE)

    /** Scans the whole statement; over-collecting CTE names only makes the floor more lenient. */
    private fun collectCteNames(sql: String): Set<String> {
        if (!HAS_WITH.containsMatchIn(sql)) return emptySet()
        return CTE_NAME.findAll(sql).map { it.groupValues[1].lowercase() }.toSet()
    }

    /** JSqlParser preserves quote characters in identifiers (`"Users"`, `` `name` ``); must be undone before comparing against the catalog's bare names. */
    private fun unquoteSegment(segment: String): String {
        val s = segment.trim()
        return if (s.length >= 2 && ((s[0] == '"' && s.last() == '"') || (s[0] == '`' && s.last() == '`'))) {
            s.substring(1, s.length - 1)
        } else {
            s
        }
    }

    private fun unquoteDotted(raw: String): String = raw.split('.').joinToString(".") { unquoteSegment(it) }

    /** @param tables the base relations the guard already found via `TablesNamesFinder`. */
    fun firstUnknownTable(sql: String, catalog: SchemaCatalog, tables: List<String>): String? {
        val known = mutableSetOf<String>()
        for (t in catalog.tables) {
            known += t.name.lowercase()
            if (t.schema != null) known += "${t.schema.lowercase()}.${t.name.lowercase()}"
        }
        val cteNames = collectCteNames(sql)

        for (entry in tables) {
            // TablesNamesFinder yields "schema.table" or "table" with quote characters preserved.
            val parts = entry.split(".").map { unquoteSegment(it).lowercase() }
            val schema = if (parts.size > 1) parts[parts.size - 2] else null
            val name = parts.last()
            if (name.isBlank()) continue
            if (cteNames.contains(name)) continue
            val qualified = if (schema != null) "$schema.$name" else name
            if (known.contains(qualified) || known.contains(name)) continue
            if (schema != null && SYSTEM_SCHEMAS.contains(schema)) continue
            if (name.startsWith("sqlite_") || name.startsWith("pg_")) continue
            return if (schema != null) "$schema.$name" else name
        }
        return null
    }

    /** A USING or NATURAL join makes a shared column legal unqualified, so those are left alone. */
    private val SHARED_JOIN_RE = Regex("""\b(using|natural)\b""", RegexOption.IGNORE_CASE)

    /**
     * An unqualified column that more than one table in the FROM list owns. Every engine rejects it,
     * so catching it here turns a database error and a repair round trip into a straight repair.
     * Mirrors ambiguousColumn in packages/core/src/engine.ts.
     */
    fun ambiguousColumn(sql: String, catalog: SchemaCatalog): String? {
        val statement = try {
            CCJSqlParserUtil.parse(sql)
        } catch (e: Exception) {
            return null // the guard already parsed it; never double-block here
        }
        if (statement !is Select) return null

        val code = withoutLiterals(sql)
        if (SHARED_JOIN_RE.containsMatchIn(code)) return null
        // The same attributability limits as the unknown-column floor: one scope only.
        if (SUBQUERY_OPEN_RE.containsMatchIn(code) || SET_OPERATION_RE.containsMatchIn(code)) return null

        val byTable = mutableMapOf<String, MutableSet<String>>()
        for (t in catalog.tables) {
            val set = byTable.getOrPut(t.name.lowercase()) { mutableSetOf() }
            for (c in t.columns) set += c.name.lowercase()
        }

        val cteNames = collectCteNames(sql)
        val queryTables = mutableListOf<String>()
        val tableNames = try {
            TablesNamesFinder<Void>().getTables(statement as net.sf.jsqlparser.statement.Statement).toList()
        } catch (e: Exception) {
            return null
        }
        for (raw in tableNames) {
            val name = raw.lowercase().substringAfterLast('.')
            if (name.isBlank()) continue
            if (cteNames.contains(name) || SYSTEM_SCHEMAS.contains(name)) return null
            if (!byTable.containsKey(name)) return null // an unknown table may own the column
            queryTables += name
        }
        if (queryTables.size < 2) return null

        val aliases = SELECT_ALIAS_RE.findAll(sql).map { it.groupValues[1].lowercase() }.toSet()
        val columnRefs = mutableListOf<Pair<String?, String>>()
        val visitor = object : ExpressionVisitorAdapter<Void>() {
            override fun <S> visit(column: Column, context: S): Void? {
                val tableName = column.table?.name?.let { unquoteDotted(it) }?.lowercase()
                val colName = column.columnName?.let { unquoteSegment(it) }?.lowercase()
                if (colName != null) columnRefs += tableName to colName
                return super.visit(column, context)
            }
        }
        try {
            visitAllExpressions(statement, visitor)
        } catch (e: Exception) {
            return null
        }

        for ((table, column) in columnRefs) {
            if (column.isBlank() || column == "*" || table != null) continue
            if (aliases.contains(column)) continue
            if (queryTables.count { byTable[it]!!.contains(column) } > 1) return column
        }
        return null
    }

    /**
     * Columns SQLite gives every table without listing them, so `PRAGMA table_info` never reports them.
     * On a WITHOUT ROWID table the database rejects the name, which the repair loop can act on.
     */
    private val SQLITE_IMPLICIT_COLUMNS = setOf("rowid", "oid", "_rowid_", "docid", "rank")

    fun firstUnknownColumn(sql: String, catalog: SchemaCatalog): UnknownColumn? {
        val statement = try {
            CCJSqlParserUtil.parse(sql)
        } catch (e: Exception) {
            return null // the guard already parsed it; never double-block here
        }
        if (statement !is Select) return null

        val byTable = mutableMapOf<String, MutableSet<String>>()
        for (t in catalog.tables) {
            val set = byTable.getOrPut(t.name.lowercase()) { mutableSetOf() }
            for (c in t.columns) set += c.name.lowercase()
        }

        val cteNames = collectCteNames(sql)
        val aliases = SELECT_ALIAS_RE.findAll(sql).map { it.groupValues[1].lowercase() }.toSet()
        val tableAliases = collectTableAliases(statement)

        // Both probes read blanked text: a literal or comment must not disable the floor.
        val code = withoutLiterals(sql)
        val hasSubquery = SUBQUERY_OPEN_RE.containsMatchIn(code)
        // A set operation has one column list per branch, and the parser reports them merged, so a column
        // from one branch would be judged against another branch's tables. Not attributable, like a subquery.
        // Blank literals first: a value like 'except this' would otherwise disable the floor entirely.
        val hasSetOperation = SET_OPERATION_RE.containsMatchIn(code)
        var attributable = !hasSubquery && !hasSetOperation

        val queryTables = mutableListOf<String>()
        val tableNames = try {
            TablesNamesFinder<Void>().getTables(statement as net.sf.jsqlparser.statement.Statement).toList()
        } catch (e: Exception) {
            attributable = false
            emptyList()
        }
        for (raw in tableNames) {
            val name = raw.lowercase().substringAfterLast('.')
            if (name.isBlank()) continue
            if (cteNames.contains(name) || SYSTEM_SCHEMAS.contains(name)) continue
            if (byTable.containsKey(name)) queryTables += name else attributable = false
        }

        val columnRefs = mutableListOf<Pair<String?, String>>()
        val visitor = object : ExpressionVisitorAdapter<Void>() {
            override fun <S> visit(column: Column, context: S): Void? {
                val tableName = column.table?.name?.let { unquoteDotted(it) }?.lowercase()
                val colName = column.columnName?.let { unquoteSegment(it) }?.lowercase()
                if (colName != null) columnRefs += tableName to colName
                return super.visit(column, context)
            }
        }
        try {
            visitAllExpressions(statement, visitor)
        } catch (e: Exception) {
            return null
        }

        for ((table, column) in columnRefs) {
            if (column.isBlank() || column == "*") continue

            if (table == null) {
                if (!attributable || aliases.contains(column) || queryTables.isEmpty()) continue
                if (catalog.engine == EngineKind.SQLITE && column.lowercase() in SQLITE_IMPLICIT_COLUMNS) continue
                if (queryTables.any { byTable[it]?.contains(column) == true }) continue
                val available = queryTables.flatMap { byTable[it].orEmpty() }.toSortedSet()
                return UnknownColumn(queryTables.first(), column, available.toList())
            }

            // `column.table.name` is whatever the query wrote, often an alias ("c" for "customers c").
            val bareTable = table.substringAfterLast('.')
            val resolvedTable = tableAliases[bareTable] ?: bareTable
            if (cteNames.contains(resolvedTable) || SYSTEM_SCHEMAS.contains(resolvedTable)) continue
            val known = byTable[resolvedTable] ?: continue // derived/subquery alias or unknown table; fail open
            if (known.contains(column)) continue
            if (catalog.engine == EngineKind.SQLITE && column.lowercase() in SQLITE_IMPLICIT_COLUMNS) continue
            return UnknownColumn(resolvedTable, column, known.toSortedSet().toList())
        }
        return null
    }

    /** Maps every table alias in the statement (FROM and JOIN items, at any nesting level) to its real, lowercased table name. */
    private fun collectTableAliases(select: Select): Map<String, String> {
        val aliases = mutableMapOf<String, String>()

        fun recordIfTable(fromItem: net.sf.jsqlparser.statement.select.FromItem?) {
            val table = fromItem as? net.sf.jsqlparser.schema.Table ?: return
            val aliasName = table.alias?.name?.let { unquoteSegment(it) }?.lowercase() ?: return
            aliases[aliasName] = unquoteDotted(table.name).lowercase().substringAfterLast('.')
        }

        fun walk(s: Select) {
            s.withItemsList?.forEach { w ->
                val body = w.parenthesedStatement
                if (body is Select) walk(body)
            }
            when (s) {
                is PlainSelect -> {
                    recordIfTable(s.fromItem)
                    (s.fromItem as? ParenthesedSelect)?.select?.let { walk(it) }
                    s.joins?.forEach { j ->
                        recordIfTable(j.rightItem)
                        (j.rightItem as? ParenthesedSelect)?.select?.let { walk(it) }
                    }
                }
                is SetOperationList -> s.selects.forEach { walk(it) }
                is ParenthesedSelect -> walk(s.select)
                else -> Unit
            }
        }
        walk(select)
        return aliases
    }

    /** Walks every SELECT item / WHERE / HAVING / GROUP BY / ORDER BY / join-on expression in the statement tree. */
    private fun visitAllExpressions(statement: net.sf.jsqlparser.statement.Statement, visitor: ExpressionVisitorAdapter<Void>) {
        if (statement !is Select) return
        visitSelect(statement, visitor)
    }

    private fun visitSelect(select: Select, visitor: ExpressionVisitorAdapter<Void>) {
        select.withItemsList?.forEach { w ->
            val body = w.parenthesedStatement
            if (body is Select) visitSelect(body, visitor)
        }
        when (select) {
            is PlainSelect -> {
                select.selectItems?.forEach { it.expression?.accept(visitor) }
                select.where?.accept(visitor)
                select.groupBy?.groupByExpressionList?.forEach { it.accept(visitor) }
                select.having?.accept(visitor)
                select.orderByElements?.forEach { it.expression?.accept(visitor) }
                select.joins?.forEach { j -> j.onExpressions?.forEach { it.accept(visitor) } }
            }
            is SetOperationList -> {
                select.selects.forEach { s -> visitSelect(s, visitor) }
            }
            is ParenthesedSelect -> visitSelect(select.select, visitor)
            else -> Unit
        }
    }

    /** The statement with string literals and line comments blanked out; offsets are preserved. */
    private fun withoutLiterals(sql: String): String {
        val out = StringBuilder(sql)
        var i = 0
        while (i < sql.length) {
            when {
                sql[i] == '\'' -> {
                    var j = i + 1
                    while (j < sql.length) {
                        if (sql[j] == '\'' && j + 1 < sql.length && sql[j + 1] == '\'') j += 2
                        else if (sql[j] == '\'') break
                        else j++
                    }
                    for (k in i..minOf(j, sql.length - 1)) out[k] = ' '
                    i = j + 1
                }
                sql[i] == '-' && i + 1 < sql.length && sql[i + 1] == '-' -> {
                    var j = i
                    while (j < sql.length && sql[j] != '\n') { out[j] = ' '; j++ }
                    i = j
                }
                sql[i] == '/' && i + 1 < sql.length && sql[i + 1] == '*' -> {
                    val close = sql.indexOf("*/", i + 2)
                    val end = if (close == -1) sql.length else close + 2
                    for (k in i until end) out[k] = ' '
                    i = end
                }
                else -> i++
            }
        }
        return out.toString()
    }
}
