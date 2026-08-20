package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.introspect.ColumnHints
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
    /** A SUM over a joined child table, which counts each parent value once per child row. */
    data class FanOut(val column: String, val parent: String, val child: String)

    private fun sameName(a: String?, b: String?): Boolean = a != null && b != null && a.equals(b, ignoreCase = true)

    /** Every FROM/JOIN item as (table, alias); only plain tables, since a subquery has its own scope. */
    private fun fromTables(select: PlainSelect): List<Pair<String, String?>> {
        val out = mutableListOf<Pair<String, String?>>()
        fun add(item: net.sf.jsqlparser.schema.Table?) {
            if (item == null) return
            out.add(item.name.trim('"', '`', '[', ']') to item.alias?.name?.trim('"', '`', '[', ']'))
        }
        add(select.fromItem as? net.sf.jsqlparser.schema.Table)
        select.joins?.forEach { add(it.rightItem as? net.sf.jsqlparser.schema.Table) }
        return out
    }

    /** SUM(x.y) in the select list, as (qualifier, column). */
    private fun selectSums(select: PlainSelect): List<Pair<String?, String>> {
        val out = mutableListOf<Pair<String?, String>>()
        for (item in select.selectItems.orEmpty()) {
            val fn = item.expression as? Function ?: continue
            if (!fn.name.equals("sum", ignoreCase = true)) continue
            val col = fn.parameters?.firstOrNull() as? Column ?: continue
            out.add(col.table?.name?.trim('"', '`', '[', ']') to col.columnName.trim('"', '`', '[', ']'))
        }
        return out
    }

    /**
     * Mirrors fanOutAggregate in packages/core/src/semantics.ts. Summing a parent's column while
     * joined to a child that has many rows per parent counts every value once per child row, so the
     * total comes back too high - read-only, guard-clean, and simply wrong.
     */
    fun fanOutAggregate(sql: String, catalog: com.rahulmahadik.asksql.ide.model.SchemaCatalog): FanOut? {
        val statement = try {
            CCJSqlParserUtil.parse(sql)
        } catch (e: Exception) {
            return null // the guard already parsed it; never double-block here
        }
        val select = statement as? Select ?: return null
        for (plain in plainSelects(select)) {
            val tables = fromTables(plain)
            if (tables.size < 2) continue
            for ((qualifier, column) in selectSums(plain)) {
                val parent = tables.firstOrNull { (name, alias) -> sameName(alias, qualifier) || sameName(name, qualifier) }?.first
                    ?: continue
                for ((candidate, _) in tables) {
                    if (sameName(candidate, parent)) continue
                    val child = catalog.tables.firstOrNull { sameName(it.name, candidate) } ?: continue
                    if (child.foreignKeys.any { sameName(it.refTable, parent) }) {
                        return FanOut(column, parent, candidate)
                    }
                }
            }
        }
        return null
    }

    /** A comparison whose two sides cannot mean the same thing: a numeric column against a date. */
    data class EpochMismatch(val column: String, val dbType: String, val comparedTo: String)

    /** Types that hold a number, so a date on the other side cannot mean the same thing. */
    private val INTEGER_DB_TYPE =
        Regex("""^(?:big\s*int|int|integer|int2|int4|int8|smallint|tinyint|mediumint|unsigned\s+big\s+int|numeric|number)\b""", RegexOption.IGNORE_CASE)

    /** SQLite's date builders plus the standard keywords; all produce text or a day number. */
    private val DATE_FUNCTION =
        Regex("""^(?:date|datetime|time|strftime|julianday|unixepoch|current_date|current_time|current_timestamp|now|getdate|sysdate)$""", RegexOption.IGNORE_CASE)

    /** A literal a person writes for a day or an instant, which is text however it is compared. */
    private val DATE_LITERAL = Regex("""^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$""")

    private fun dateSideOf(expression: Expression?): String? = when (expression) {
        null -> null
        is net.sf.jsqlparser.expression.Function ->
            if (DATE_FUNCTION.matches(expression.name ?: "")) "${expression.name}(...)" else null
        is net.sf.jsqlparser.expression.TimeKeyExpression ->
            if (DATE_FUNCTION.matches((expression.stringValue ?: "").replace(" ", "_"))) expression.stringValue else null
        is net.sf.jsqlparser.expression.StringValue ->
            if (DATE_LITERAL.matches(expression.value.trim())) "'${expression.value}'" else null
        is net.sf.jsqlparser.expression.CastExpression -> dateSideOf(expression.leftExpression)
        else -> null
    }

    /** The catalog type of a column named anywhere in the query, or null when it is not attributable. */
    private fun dbTypeOf(column: String, catalog: com.rahulmahadik.asksql.ide.model.SchemaCatalog): String? {
        val types = catalog.tables.flatMap { t -> t.columns.filter { it.name.equals(column, true) }.map { it.dbType } }
        if (types.isEmpty()) return null
        // Two tables typing the same name differently is not attributable from the name alone.
        return types.first().takeIf { first -> types.all { it.equals(first, true) } }
    }

    /**
     * A numeric column compared against a date: against text nothing matches, against epoch seconds a
     * milliseconds column matches every row, and neither errors. Mirrors core's semantics.ts.
     */
    fun epochUnitMismatch(sql: String, catalog: com.rahulmahadik.asksql.ide.model.SchemaCatalog): EpochMismatch? {
        val statement = try {
            CCJSqlParserUtil.parse(sql)
        } catch (e: Exception) {
            return null // the guard already parsed it; never double-block here
        }
        val select = statement as? Select ?: return null

        fun checkPair(maybeColumn: Expression?, maybeDate: Expression?): EpochMismatch? {
            val col = maybeColumn as? net.sf.jsqlparser.schema.Column ?: return null
            val name = col.columnName ?: return null
            val dbType = dbTypeOf(name, catalog) ?: return null
            if (!INTEGER_DB_TYPE.containsMatchIn(dbType.trim())) return null
            val rendered = dateSideOf(maybeDate) ?: return null
            return EpochMismatch(name, dbType, rendered)
        }

        // The file's own reflective walk, rather than a visitor: JSqlParser's visitor is generic here
        // and every comparison would need its own override.
        fun scanExpression(expression: Expression?, depth: Int = 0): EpochMismatch? {
            if (expression == null || depth > MAX_DEPTH) return null
            when (expression) {
                is net.sf.jsqlparser.expression.operators.relational.ComparisonOperator ->
                    checkPair(expression.leftExpression, expression.rightExpression)
                        ?: checkPair(expression.rightExpression, expression.leftExpression)
                is net.sf.jsqlparser.expression.operators.relational.Between ->
                    checkPair(expression.leftExpression, expression.betweenExpressionStart)
                        ?: checkPair(expression.leftExpression, expression.betweenExpressionEnd)
                else -> null
            }?.let { return it }
            for (child in childrenOf(expression)) scanExpression(child, depth + 1)?.let { return it }
            return null
        }

        for (plain in plainSelects(select)) {
            scanExpression(plain.where)?.let { return it }
            scanExpression(plain.having)?.let { return it }
            plain.joins?.forEach { j -> j.onExpressions?.forEach { on -> scanExpression(on)?.let { return it } } }
        }
        return null
    }

/** [schema] is carried so the probe can qualify the relation; unqualified it was inert off search_path. */
    data class CodeLiteral(val schema: String?, val table: String, val column: String, val literal: Long)

    /**
     * A measurement, not a code. An absent age or salary is a true zero, and telling the reader it
     * "returned nothing for that reason" says a correct answer is an artifact.
     */
    private val MEASURE_NAME = Regex(
        "(?:^|_)(?:age|salary|wage|pay|price|amount|cost|fee|total|sum|qty|quantity|count|score|rating|rank|year|month|day|week|hour|minute|second|size|weight|height|width|length|depth|duration|percent|percentage|rate|balance|stock|level)s?$",
        RegexOption.IGNORE_CASE,
    )

    /** An identifier, not a code: an absent id is an ordinary empty result. */
    private val ID_NAME = Regex("""(?:^|_)(?:id|ids|key|uuid|guid|hash)$""", RegexOption.IGNORE_CASE)

    private val MOMENT_NAME = Regex(
        """(?:^|_)(?:at|ts|time|date|timestamp|created|updated|modified|deleted|expires?|expiry|sent|received|due|since|until)(?:_|$)|(?:time|date|timestamp)$""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * Which table a bare column belongs to. Only the tables this statement names are considered: judged
     * against the whole catalog, any schema with two `status` columns made every such reference
     * ambiguous and the check went silent. A name two tables in the query share is still skipped.
     */
    private fun ownerOf(
        column: String,
        catalog: com.rahulmahadik.asksql.ide.model.SchemaCatalog,
        inScope: Map<String, String> = emptyMap(),
    ) = catalog.tables
        .filter { t -> inScope.isEmpty() || inScope.values.any { it.equals(t.name, true) } }
        .filter { t -> t.columns.any { it.name.equals(column, true) } }
        .singleOrNull()

    /**
     * An integer column compared against a whole-number code: `status = 2`. What 2 means lives in the
     * application, so a wrong ordinal matches nothing and reads as a true zero. Mirrors core's semantics.ts.
     */
    fun codeLiterals(sql: String, catalog: com.rahulmahadik.asksql.ide.model.SchemaCatalog): List<CodeLiteral> {
        val statement = try {
            CCJSqlParserUtil.parse(sql)
        } catch (e: Exception) {
            return emptyList()
        }
        val select = statement as? Select ?: return emptyList()
        val found = LinkedHashMap<String, CodeLiteral>()

        fun consider(maybeColumn: Expression?, maybeValue: Expression?, inScope: Map<String, String>) {
            val col = maybeColumn as? net.sf.jsqlparser.schema.Column ?: return
            val name = col.columnName ?: return
            if (ID_NAME.containsMatchIn(name) || MEASURE_NAME.containsMatchIn(name)) return
            val dbType = dbTypeOf(name, catalog) ?: return
            if (!INTEGER_DB_TYPE.containsMatchIn(dbType.trim())) return
            if (ColumnHints.isMoment(name, dbType)) return
            // Read first: without it, two tables sharing `status` made every such reference ambiguous.
            val qualifier = col.table?.name?.lowercase()
            val owner = if (qualifier != null) {
                val target = inScope[qualifier] ?: qualifier
                catalog.tables.firstOrNull { it.name.equals(target, true) && it.columns.any { c -> c.name.equals(name, true) } }
            } else {
                ownerOf(name, catalog, inScope)
            } ?: return
            // Reading a view runs its query.
            if (owner.kind != com.rahulmahadik.asksql.ide.model.TableKind.TABLE) return
            if (owner.primaryKey.any { it.equals(name, true) }) return
            if (owner.foreignKeys.any { fk -> fk.columns.any { it.equals(name, true) } }) return
            // SignedExpression, not LongValue; -1 is the conventional unset sentinel in Room schemas.
            val literal = when (maybeValue) {
                is net.sf.jsqlparser.expression.LongValue -> maybeValue.value
                is net.sf.jsqlparser.expression.SignedExpression -> {
                    val inner = (maybeValue.expression as? net.sf.jsqlparser.expression.LongValue)?.value ?: return
                    if (maybeValue.sign == '-') -inner else inner
                }
                else -> return
            }
            val key = "${owner.name}.$name=$literal".lowercase()
            found.putIfAbsent(key, CodeLiteral(owner.schema, owner.name, name, literal))
        }

        /**
         * Follows AND from WHERE only: under OR, NOT, CASE or a partial IN the query returns rows and a
         * caveat there contradicts the answer. Mirrors packages/core/src/semantics.ts.
         */
        fun walkConjunction(expression: Expression?, depth: Int, inScope: Map<String, String>) {
            if (expression == null || depth > MAX_DEPTH) return
            when (expression) {
                is net.sf.jsqlparser.expression.operators.conditional.AndExpression -> {
                    walkConjunction(expression.leftExpression, depth + 1, inScope)
                    walkConjunction(expression.rightExpression, depth + 1, inScope)
                }
                is net.sf.jsqlparser.expression.operators.relational.EqualsTo -> {
                    consider(expression.leftExpression, expression.rightExpression, inScope)
                    consider(expression.rightExpression, expression.leftExpression, inScope)
                }
                is net.sf.jsqlparser.expression.Parenthesis -> walkConjunction(expression.expression, depth + 1, inScope)
                else -> Unit // OR, NOT, CASE and everything else leave the result undecided
            }
        }

        for (plain in plainSelects(select)) {
            val inScope = mutableMapOf<String, String>()
            for ((table, alias) in fromTables(plain)) {
                alias?.let { inScope[it.lowercase()] = table }
                inScope[table.lowercase()] = table
            }
            walkConjunction(plain.where, 0, inScope)
        }
        return found.values.toList()
    }

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

    /**
     * An aggregate nested inside another aggregate, like AVG(x + SUM(y)). Every engine rejects it, so
     * catching it before execution turns a database error into a repair. Returns the outer function name.
     */
    fun nestedAggregate(sql: String): String? {
        val statement = try {
            CCJSqlParserUtil.parse(sql)
        } catch (e: Exception) {
            return null // the guard already fails closed on unparsable SQL
        }
        val select = statement as? Select ?: return null
        for (body in plainSelects(select)) {
            // Every clause an aggregate can appear in, matching the TypeScript walk over the statement.
            val clauses = (body.selectItems ?: emptyList()).map { it.expression } +
                listOfNotNull(body.having, body.where) +
                (body.orderByElements ?: emptyList()).map { it.expression } +
                (body.groupBy?.groupByExpressionList?.toList() ?: emptyList<Expression>())
            for (clause in clauses) {
                val outer = findNested(clause, null)
                if (outer != null) return outer
            }
        }
        return null
    }

    private fun findNested(node: Expression?, insideAggregate: String?): String? {
        if (node == null) return null
        // A subquery has its own scope, so an aggregate inside one is not nested in the outer call.
        if (node is Select || node is ParenthesedSelect) return null
        val isAgg = node is Function && isBareAggregate(node)
        if (isAgg && insideAggregate != null) return insideAggregate
        val within = if (isAgg) (node as Function).name?.uppercase() else insideAggregate
        for (child in childrenOf(node)) {
            val found = findNested(child, within)
            if (found != null) return found
        }
        return null
    }
}
