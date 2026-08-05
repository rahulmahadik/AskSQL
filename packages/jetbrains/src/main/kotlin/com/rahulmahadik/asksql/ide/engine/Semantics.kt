package com.rahulmahadik.asksql.ide.engine

import net.sf.jsqlparser.expression.AnalyticExpression
import net.sf.jsqlparser.expression.AnalyticType
import net.sf.jsqlparser.expression.Expression
import net.sf.jsqlparser.expression.Function
import net.sf.jsqlparser.parser.CCJSqlParserUtil
import net.sf.jsqlparser.schema.Column
import net.sf.jsqlparser.statement.select.ParenthesedSelect
import net.sf.jsqlparser.statement.select.PlainSelect
import net.sf.jsqlparser.statement.select.Select
import net.sf.jsqlparser.statement.select.SetOperationList

/**
 * Semantic lints, the Kotlin half of core's `semantics.ts`: SQL the guard allows because it is
 * read-only, but that answers the wrong question. Narrow on purpose - a false positive costs a
 * repair round on a correct query.
 */
object Semantics {

    private val AGGREGATES = setOf("count", "sum", "avg", "min", "max", "group_concat", "string_agg", "array_agg")

    /** Deep enough for any real select list; a bound in case a getter ever hands back its own node. */
    private const val MAX_DEPTH = 40

    private class Scan {
        var aggregate = false
        var column = false
        var firstColumn: String? = null
    }

    /**
     * A windowed aggregate needs no GROUP BY. JSqlParser parses `count(*) OVER (...)` as an
     * [AnalyticExpression] rather than a [Function], so a Function here is always the bare form.
     */
    private fun isBareAggregate(f: Function): Boolean {
        val name = f.name?.lowercase() ?: return false
        if (name !in AGGREGATES) return false
        // Multi-argument min/max is SQLite's scalar form and needs no GROUP BY.
        if ((name == "min" || name == "max") && (f.parameters?.size ?: 0) > 1) return false
        return true
    }

    /**
     * Child expressions of any node, found by reflection rather than by listing every class.
     * JSqlParser has ~90 expression types; an enumeration silently skips whole shapes.
     */
    private fun childrenOf(node: Expression): List<Expression> {
        val out = ArrayList<Expression>()
        for (method in node.javaClass.methods) {
            if (method.parameterCount != 0 || !method.name.startsWith("get")) continue
            // getParent walks UP the tree, which would reach the enclosing aggregate again.
            if (method.name == "getParent" || method.name == "getASTNode") continue
            // A window's PARTITION BY / ORDER BY columns are not select-list columns.
            if (method.name.startsWith("getWindow") || method.name.startsWith("getPartition") || method.name == "getOrderByElements") continue
            val value = try {
                method.invoke(node)
            } catch (e: ReflectiveOperationException) {
                continue
            }
            when {
                // Iterable FIRST: ExpressionList is both, and as an Expression it is opaque.
                value is Iterable<*> -> value.forEach { if (it is Expression) out += it }
                value is Array<*> -> value.forEach { if (it is Expression) out += it }
                value is Expression -> if (value !== node) out += value
            }
        }
        return out
    }

    private fun walk(expression: Expression?, scan: Scan, insideAggregate: Boolean = false, depth: Int = 0) {
        if (expression == null || depth > MAX_DEPTH) return
        // A subquery answers its own question; its columns do not belong to this select list.
        if (expression is Select) return
        when {
            expression is Function && isBareAggregate(expression) -> {
                scan.aggregate = true
                expression.parameters?.forEach { walk(it, scan, true, depth + 1) }
            }
            expression is AnalyticExpression -> {
                // FILTER (WHERE ...) is not a window; only a real OVER clause replaces GROUP BY.
                if (expression.type == AnalyticType.FILTER_ONLY) scan.aggregate = true
                walk(expression.expression, scan, insideAggregate, depth + 1)
            }
            expression is Column -> {
                if (!insideAggregate) {
                    scan.column = true
                    if (scan.firstColumn == null) scan.firstColumn = expression.columnName
                }
            }
            else -> childrenOf(expression).forEach { walk(it, scan, insideAggregate, depth + 1) }
        }
    }

    /** Every PlainSelect in a statement, so a UNION arm is checked like a standalone query. */
    private fun plainSelects(select: Select): List<PlainSelect> = when (select) {
        is PlainSelect -> listOf(select)
        is SetOperationList -> select.selects.flatMap { plainSelects(it) }
        is ParenthesedSelect -> plainSelects(select.select)
        else -> emptyList()
    }

    /**
     * `SELECT status, count(*) FROM orders` with no GROUP BY: rejected by PostgreSQL and by MySQL
     * in strict mode, and silently wrong in SQLite - it returns one arbitrary row. Returns the
     * column that needs grouping, or null when the query is fine.
     */
    fun ungroupedAggregate(sql: String): String? {
        val statement = try {
            CCJSqlParserUtil.parse(sql)
        } catch (e: Exception) {
            return null // the guard already fails closed on unparsable SQL
        }
        val select = statement as? Select ?: return null
        for (body in plainSelects(select)) {
            if (body.groupBy != null) continue
            val scan = Scan()
            for (item in body.selectItems ?: emptyList()) walk(item.expression, scan)
            if (scan.aggregate && scan.column) return scan.firstColumn ?: "that column"
        }
        return null
    }
}
