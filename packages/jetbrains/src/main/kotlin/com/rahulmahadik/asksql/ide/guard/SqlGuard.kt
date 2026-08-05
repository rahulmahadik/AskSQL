package com.rahulmahadik.asksql.ide.guard

import com.rahulmahadik.asksql.ide.model.DialectInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.GuardPolicy
import com.rahulmahadik.asksql.ide.model.GuardVerdict
import com.rahulmahadik.asksql.ide.model.LimitStyle
import net.sf.jsqlparser.JSQLParserException
import net.sf.jsqlparser.expression.Expression
import net.sf.jsqlparser.expression.ExpressionVisitorAdapter
import net.sf.jsqlparser.expression.Function
import net.sf.jsqlparser.expression.LongValue
import net.sf.jsqlparser.parser.CCJSqlParserUtil
import net.sf.jsqlparser.schema.Column
import net.sf.jsqlparser.schema.Table
import net.sf.jsqlparser.statement.Statement
import net.sf.jsqlparser.statement.select.FromItem
import net.sf.jsqlparser.statement.select.Join
import net.sf.jsqlparser.statement.select.LateralSubSelect
import net.sf.jsqlparser.statement.select.ParenthesedFromItem
import net.sf.jsqlparser.statement.select.ParenthesedSelect
import net.sf.jsqlparser.statement.select.PlainSelect
import net.sf.jsqlparser.statement.select.Select
import net.sf.jsqlparser.statement.select.SelectItem
import net.sf.jsqlparser.statement.select.SetOperationList
import net.sf.jsqlparser.statement.select.Values
import net.sf.jsqlparser.util.TablesNamesFinder

/**
 * The AskSQL security boundary: deterministic, AST-based, fail-closed. Allows a single SELECT (CTEs verified
 * recursively), a small read-only PRAGMA/SHOW allowlist, and EXPLAIN of a guarded SELECT. Parity contract: a strict subset of core's `guard.ts`.
 */
object SqlGuard {

    private val EXPLAIN_PREFIX = Regex(
        """^\s*explain(\s+query\s+plan|\s+analyze|\s+verbose|\s*\([^)]*\))*\s+""",
        RegexOption.IGNORE_CASE,
    )
    private val LOCKING_CLAUSE = Regex(
        """\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val LOCK_IN_SHARE_MODE = Regex("""\block\s+in\s+share\s+mode\b""", RegexOption.IGNORE_CASE)
    private val INTO_OUTFILE = Regex("""\binto\s+(outfile|dumpfile)\b""", RegexOption.IGNORE_CASE)
    private val SQLITE_PRAGMA = Regex(
        """^\s*pragma\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*([A-Za-z0-9_."'`]+)\s*\))?\s*$""",
        RegexOption.IGNORE_CASE,
    )
    private val SQLITE_PRAGMA_ANY = Regex("""^\s*pragma\b""", RegexOption.IGNORE_CASE)
    private val MYSQL_SHOW_OR_DESCRIBE = Regex("""^\s*(show|desc|describe)\b""", RegexOption.IGNORE_CASE)
    private val MYSQL_DESCRIBE_TABLE = Regex("""^\s*(desc|describe)\s+[A-Za-z0-9_.`"]+\s*$""", RegexOption.IGNORE_CASE)

    fun guard(sql: String, dialect: DialectInfo, policy: GuardPolicy = GuardPolicy.DEFAULT): GuardVerdict {
        val original = sql
        val trimmed = original.trim()

        if (trimmed.isEmpty()) return blocked(original, "empty", "The statement is empty.")
        if (trimmed.length > policy.maxSqlLength) {
            return blocked(original, "too_long", "The statement is too long to verify safely.")
        }

        // MySQL executes the body of its bang-style executable comments, which a comment stripper hides.
        if (dialect.engine == EngineKind.MYSQL && hasMysqlExecutableComment(trimmed)) {
            return blocked(original, "mysql_executable_comment", "MySQL executable comments are not allowed.")
        }

        val stripped = SqlLexer.stripCommentsAndStrings(trimmed)
        if (SqlLexer.hasMultipleStatements(stripped)) {
            return blocked(original, "multi_statement", "Only a single statement is allowed.")
        }
        val strippedTrim = stripped.trim().removeSuffix(";").trimEnd()
        val body = trimmed.trimEnd().let { if (it.endsWith(";")) it.dropLast(1) else it }.trim()

        // ---- Dialect-specific allowlisted read commands (checked pre-parser) ----
        if (dialect.engine == EngineKind.SQLITE && SQLITE_PRAGMA_ANY.containsMatchIn(strippedTrim)) {
            val m = SQLITE_PRAGMA.find(body)
            return if (m != null && DenyLists.SQLITE_PRAGMA_READ_ALLOWLIST.contains(m.groupValues[1].lowercase())) {
                GuardVerdict(allowed = true, sql = body)
            } else {
                blocked(original, "pragma_denied", "Only read-only PRAGMA commands are allowed.")
            }
        }

        if (dialect.engine == EngineKind.MYSQL && MYSQL_SHOW_OR_DESCRIBE.containsMatchIn(strippedTrim)) {
            return when {
                DenyLists.MYSQL_SHOW_ALLOW.containsMatchIn(strippedTrim) -> GuardVerdict(allowed = true, sql = body)
                MYSQL_DESCRIBE_TABLE.containsMatchIn(body) -> GuardVerdict(allowed = true, sql = body)
                else -> blocked(original, "show_denied", "Only read-only SHOW/DESCRIBE commands are allowed.")
            }
        }

        // ---- EXPLAIN wrapper: guard the inner statement, keep the prefix ----
        var inner = body
        var explainPrefix = ""
        val explainMatch = EXPLAIN_PREFIX.find(body)
        if (explainMatch != null && explainMatch.range.first == 0) {
            explainPrefix = body.substring(0, explainMatch.value.length)
            inner = body.substring(explainMatch.value.length)
        }

        // ---- Lexical read-only floor (belt for shapes the AST may not expose) ----
        val strippedInner = SqlLexer.stripCommentsAndStrings(inner)
        if (LOCKING_CLAUSE.containsMatchIn(strippedInner) || LOCK_IN_SHARE_MODE.containsMatchIn(strippedInner)) {
            return blocked(original, "locking_clause", "Row-locking clauses (FOR UPDATE/SHARE) are not allowed.")
        }
        if (INTO_OUTFILE.containsMatchIn(strippedInner)) {
            return blocked(original, "into_outfile", "Writing query output to files is not allowed.")
        }
        // Models write `col` out of MySQL habit whatever the dialect, and JSqlParser accepts it.
        if (dialect.quoteChar != '`' && strippedInner.contains('`')) {
            return blocked(
                original,
                "backtick_identifier",
                "Backtick-quoted identifiers are MySQL-only. ${dialect.promptLabel} quotes identifiers with " +
                    "${dialect.quoteChar}: write ${dialect.quoteChar}Order Status${dialect.quoteChar}, not `Order Status`.",
            )
        }

        // ---- Parse once, fail-closed ----
        val statement: Statement = try {
            CCJSqlParserUtil.parse(inner)
        } catch (e: JSQLParserException) {
            return blocked(original, "parse_failed", "The statement could not be verified as safe SQL for this database, so it was blocked.")
        } catch (e: StackOverflowError) {
            // Pathologically deep nesting overflows the parser's own stack before walkSelect's depth check ever runs.
            return blocked(original, "too_deep", "The statement is nested too deeply to verify safely.")
        } catch (e: Exception) {
            // JSqlParser can throw non-JSQLParserException runtime errors on pathological input.
            return blocked(original, "parse_failed", "The statement could not be verified as safe SQL for this database, so it was blocked.")
        }

        if (statement !is Select) {
            val kind = statement.javaClass.simpleName
            return blocked(original, "statement_not_allowed:$kind", "Only read-only SELECT statements are allowed (found ${kind.uppercase()}).")
        }

        val denySet = DenyLists.denySetFor(dialect.engine, policy)
        val denySuffixes = DenyLists.denySuffixesFor(dialect.engine)
        val denyPrefixes = DenyLists.denyPrefixesFor(dialect.engine, policy)
        val ctx = WalkContext(denySet, denySuffixes, denyPrefixes, policy.maxDepth, dialect.engine)

        val violation = try {
            walkSelect(statement, ctx, depth = 0)
        } catch (e: StackOverflowError) {
            Violation("too_deep", "The statement is nested too deeply to verify safely.")
        }
        if (violation != null) {
            return blocked(original, violation.ruleId, violation.reason)
        }

        val tables = try {
            TablesNamesFinder<Void>().getTables(statement as net.sf.jsqlparser.statement.Statement).toList()
        } catch (e: StackOverflowError) {
            emptyList()
        } catch (e: Exception) {
            emptyList()
        }

        // ---- Row cap (skipped under EXPLAIN; plans don't return rows) ----
        val warnings = mutableListOf<String>()
        var autoLimited = false
        var loweredLimit = false
        var finalSql = body

        if (explainPrefix.isEmpty()) {
            val target = effectiveLimitTarget(statement)
            // This dialect has no LIMIT. Refusing it sends the query back to be rewritten, instead of
            // appending FETCH FIRST to a statement the database will reject anyway.
            if (dialect.limitStyle == LimitStyle.FETCH && target?.limit != null) {
                return blocked(
                    sql,
                    "limit_unsupported",
                    "${dialect.promptLabel} has no LIMIT clause. Remove it and order the results instead; " +
                        "the row cap is applied when the query runs.",
                )
            }
            when (val status = inspectLimit(target, policy.maxRows, dialect.limitStyle)) {
                is LimitStatus.None -> {
                    // Textual append on its own line, so a trailing `--`/`#` comment in `body` can't hide it.
                    finalSql = if (dialect.limitStyle == LimitStyle.FETCH) {
                        "$body\nFETCH FIRST ${policy.maxRows} ROWS ONLY"
                    } else {
                        "$body\nLIMIT ${policy.maxRows}"
                    }
                    autoLimited = true
                }
                is LimitStatus.High -> {
                    status.apply()
                    finalSql = try {
                        statement.toString()
                    } catch (e: Exception) {
                        body
                    }
                    loweredLimit = true
                }
                is LimitStatus.NonLiteral -> {
                    warnings += "Row limit uses a non-literal value; the row cap is enforced at execution time instead."
                }
                is LimitStatus.Ok -> Unit
            }
        } else {
            finalSql = explainPrefix + inner
        }

        return GuardVerdict(
            allowed = true,
            sql = finalSql,
            warnings = warnings,
            autoLimited = autoLimited,
            loweredLimit = loweredLimit,
            tables = tables,
        )
    }

    private fun blocked(sql: String, ruleId: String, reason: String) =
        GuardVerdict(allowed = false, sql = sql, ruleId = ruleId, reason = reason)

    // True if the raw SQL contains a MySQL executable-comment opener (slash, star, bang) outside a string literal.
    private fun hasMysqlExecutableComment(sql: String): Boolean {
        var i = 0
        val n = sql.length
        while (i < n) {
            val c = sql[i]
            if (c == '\'' || c == '"' || c == '`') {
                val quote = c
                i++
                while (i < n) {
                    if (sql[i] == '\\' && quote != '`') { i += 2; continue }
                    if (sql[i] == quote && i + 1 < n && sql[i + 1] == quote) { i += 2; continue }
                    if (sql[i] == quote) { i++; break }
                    i++
                }
                continue
            }
            if ((c == '-' && i + 1 < n && sql[i + 1] == '-') || c == '#') {
                while (i < n && sql[i] != '\n' && sql[i] != '\r') i++
                continue
            }
            if (c == '/' && i + 1 < n && sql[i + 1] == '*' && i + 2 < n && sql[i + 2] == '!') return true
            i++
        }
        return false
    }

    // -------------------------------------------------------------------
    // AST walk
    // -------------------------------------------------------------------

    private data class Violation(val ruleId: String, val reason: String)

    private class WalkContext(
        val denySet: Set<String>,
        val denySuffixes: List<String>,
        val denyPrefixes: List<String>,
        val maxDepth: Int,
        val engine: EngineKind,
    )

    /** Strips one layer of `"..."`/`` `...` `` quoting; JSqlParser's `Function.getName()` keeps quote characters verbatim. */
    private fun unquoteSegment(segment: String): String {
        val s = segment.trim()
        return if (s.length >= 2 && ((s[0] == '"' && s.last() == '"') || (s[0] == '`' && s.last() == '`'))) {
            s.substring(1, s.length - 1)
        } else {
            s
        }
    }

    /** Checks one function-call node's name against the deny set/suffixes/prefixes. Shared by the expression visitor and the FROM-item check. */
    private fun checkDeniedFunctionName(function: Function, ctx: WalkContext): Violation? {
        val raw = function.name ?: return null
        // Each dot segment is quote-stripped and lowercased independently, so a schema qualifier or quoting can't change what it normalizes to.
        val segments = raw.split('.').map { unquoteSegment(it).lowercase() }
        val name = segments.joinToString(".")
        val last = segments.last()
        // Package-prefix denials (e.g. "utl_file.") name the second-to-last segment, not a string prefix of the full name; qualifier-count-independent.
        val packageSegment = segments.getOrNull(segments.size - 2)
        val isDenied = ctx.denySet.contains(name) || ctx.denySet.contains(last) ||
            ctx.denySuffixes.any { last.endsWith(it) } ||
            ctx.denyPrefixes.any { prefix ->
                last.startsWith(prefix) || name.startsWith(prefix) ||
                    (packageSegment != null && packageSegment == prefix.removeSuffix("."))
            }
        return if (isDenied) Violation("function_denied:$last", "The function $last is not allowed.") else null
    }

    /**
     * Recursively verifies a [Select], covering CTE bodies, subqueries in FROM (including LATERAL),
     * and every expression tree. Returns the first [Violation], or null if the whole tree is clean.
     */
    private fun walkSelect(select: Select, ctx: WalkContext, depth: Int): Violation? {
        if (depth > ctx.maxDepth) return Violation("too_deep", "The statement is nested too deeply to verify safely.")

        // JSqlParser's WithItem can carry a writable body (a "writable CTE"), so each CTE body is type-checked.
        val withItems = try {
            select.withItemsList
        } catch (e: Exception) {
            null
        }
        if (withItems != null) {
            for (withItem in withItems) {
                val body = withItem.parenthesedStatement
                if (body !is Select) {
                    return Violation(
                        "writable_cte",
                        "Only read-only WITH clauses are allowed (found a writable common table expression).",
                    )
                }
                walkSelect(body, ctx, depth + 1)?.let { return it }
            }
        }

        return when (select) {
            is PlainSelect -> walkPlainSelect(select, ctx, depth)
            is SetOperationList -> {
                for (s in select.selects) {
                    if (s is Select) walkSelect(s, ctx, depth + 1)?.let { return it }
                }
                null
            }
            is ParenthesedSelect -> walkSelect(select.select, ctx, depth + 1)
            // VALUES(...) is itself a Select in JSqlParser's grammar and can carry arbitrary expressions.
            is Values -> checkValuesExpressions(select.expressions, ctx, depth)
            else -> null
        }
    }

    /** Walks every expression in a VALUES row-constructor list through the same [SecurityExpressionVisitor] every other expression tree uses. */
    private fun checkValuesExpressions(expressions: net.sf.jsqlparser.expression.operators.relational.ExpressionList<*>, ctx: WalkContext, depth: Int): Violation? {
        var violation: Violation? = null
        val visitor = SecurityExpressionVisitor(ctx, depth + 1) { violation = it }
        expressions.accept(visitor)
        return violation
    }

    private fun walkPlainSelect(plain: PlainSelect, ctx: WalkContext, depth: Int): Violation? {
        // SELECT ... INTO <relation> creates a table; not read-only.
        val intoTables = try { plain.intoTables } catch (e: Exception) { null }
        if (!intoTables.isNullOrEmpty()) {
            return Violation("select_into", "SELECT INTO creates a new table and is not allowed in read-only mode.")
        }

        var violation: Violation? = null
        val exprVisitor = SecurityExpressionVisitor(ctx, depth + 1) { violation = it }

        fun checkFromItem(item: FromItem?) {
            if (item == null || violation != null) return
            when (item) {
                is Table -> {
                    val name = item.fullyQualifiedName ?: item.name ?: ""
                    if (looksLikeFileOrUrl(name)) {
                        violation = Violation(
                            "file_relation",
                            "Reading a file or URL directly in a query is not allowed. Query registered tables by name.",
                        )
                    }
                }
                is ParenthesedFromItem -> checkFromItem(item.fromItem)
                // LateralSubSelect extends ParenthesedSelect, so this branch covers lateral subqueries too.
                is ParenthesedSelect -> walkSelect(item.select, ctx, depth + 1)?.let { violation = it }
                // A FROM-clause table function (e.g. `FROM dblink(...)`) is a `TableFunction` node, not one the expression visitor sees.
                is net.sf.jsqlparser.statement.select.TableFunction -> {
                    checkDeniedFunctionName(item.function, ctx)?.let { violation = it }
                    item.function.parameters?.forEach { it.accept(exprVisitor) }
                }
                // FROM (VALUES (...)) / JOIN (VALUES (...)) carries the same arbitrary expressions as the top-level case.
                is Values -> checkValuesExpressions(item.expressions, ctx, depth)?.let { violation = it }
                else -> Unit // FromQuery carries no nested SQL to walk
            }
        }

        checkFromItem(plain.fromItem)
        if (violation != null) return violation

        plain.joins?.forEach { join: Join ->
            if (violation != null) return@forEach
            checkFromItem(join.rightItem)
            join.onExpressions?.forEach { it.accept(exprVisitor) }
        }
        if (violation != null) return violation

        plain.selectItems?.forEach { item: SelectItem<*> -> item.expression?.accept(exprVisitor) }
        if (violation != null) return violation

        plain.where?.accept(exprVisitor)
        if (violation != null) return violation

        plain.groupBy?.groupByExpressionList?.forEach { it.accept(exprVisitor) }
        plain.having?.accept(exprVisitor)
        plain.orderByElements?.forEach { it.expression?.accept(exprVisitor) }

        // LIMIT/OFFSET/DISTINCT ON/WINDOW can all hold arbitrary expressions in JSqlParser's grammar.
        plain.limit?.rowCount?.accept(exprVisitor)
        plain.limit?.offset?.accept(exprVisitor)
        plain.limit?.byExpressions?.forEach { it.accept(exprVisitor) }
        plain.limitBy?.rowCount?.accept(exprVisitor)
        plain.offset?.offset?.accept(exprVisitor)
        plain.distinct?.onSelectItems?.forEach { it.expression?.accept(exprVisitor) }
        plain.windowDefinitions?.forEach { w ->
            w.partitionBy?.partitionExpressionList?.forEach { it.accept(exprVisitor) }
            w.orderBy?.orderByElements?.forEach { it.expression?.accept(exprVisitor) }
        }

        return violation
    }

    /**
     * Visits every expression reachable from a SELECT's clauses; only [Function] nodes matter, plus
     * nested subqueries which recurse back into [walkSelect]. `<Void>`: no return value needed.
     */
    private class SecurityExpressionVisitor(
        private val ctx: WalkContext,
        private val depth: Int,
        private val onViolation: (Violation) -> Unit,
    ) : ExpressionVisitorAdapter<Void>() {

        private var stopped = false

        override fun <S> visit(function: Function, context: S): Void? {
            if (stopped) return null
            checkDeniedFunctionName(function, ctx)?.let {
                stopped = true
                onViolation(it)
                return null
            }
            return super.visit(function, context)
        }

        // Every Select subtype's accept() resolves to visit(Select, S) at JSqlParser's compile time.
        override fun <S> visit(select: net.sf.jsqlparser.statement.select.Select, context: S): Void? {
            if (stopped) return null
            walkSelect(select, ctx, depth + 1)?.let {
                stopped = true
                onViolation(it)
            }
            return null
        }

        // Oracle's `seq.NEXTVAL`/`seq.CURRVAL` is a pseudo-column, which JSqlParser parses as a Column.
        // The table qualifier is required, so a bare column merely named "nextval" is not flagged.
        override fun <S> visit(column: Column, context: S): Void? {
            if (stopped) return null
            if (ctx.engine == EngineKind.ORACLE && column.table != null && column.columnName?.lowercase() in SEQUENCE_PSEUDO_COLUMNS) {
                stopped = true
                onViolation(Violation("sequence_pseudo_column", "Referencing a sequence's NEXTVAL/CURRVAL is not allowed."))
                return null
            }
            return super.visit(column, context)
        }
    }

    private val SEQUENCE_PSEUDO_COLUMNS = setOf("nextval", "currval")

    /** True when a relation name is really a path/URL/data-file name, which DuckDB's replacement scan reads as a file. */
    private fun looksLikeFileOrUrl(name: String): Boolean {
        return Regex("""[/\\]""").containsMatchIn(name) ||
            Regex("""^[a-zA-Z][a-zA-Z0-9+.-]*://""").containsMatchIn(name) ||
            name.startsWith("~") ||
            Regex("""^[a-zA-Z]:[\\/]""").containsMatchIn(name) ||
            Regex(""".*\.(csv|tsv|txt|parquet|json|ndjson|jsonl|xlsx|xls|arrow|avro|orc|feather|db|duckdb|sqlite)$""", RegexOption.IGNORE_CASE).matches(name)
    }

    // -------------------------------------------------------------------
    // Row-limit inspection / injection / lowering
    // -------------------------------------------------------------------

    private sealed interface LimitStatus {
        data object None : LimitStatus
        data object Ok : LimitStatus
        data object NonLiteral : LimitStatus
        class High(val apply: () -> Unit) : LimitStatus
    }

    /** The final SELECT of a set-operation chain (or the plain select itself) is where a trailing LIMIT binds. */
    private fun effectiveLimitTarget(select: Select): PlainSelect? = when (select) {
        is PlainSelect -> select
        is SetOperationList -> select.selects.lastOrNull() as? PlainSelect
        is ParenthesedSelect -> effectiveLimitTarget(select.select)
        else -> null
    }

    private fun inspectLimit(target: PlainSelect?, maxRows: Int, style: LimitStyle): LimitStatus {
        // FETCH FIRST (Oracle) is a distinct JSqlParser node from LIMIT: getFetch() vs. getLimit(), read via getExpression().
        if (style == LimitStyle.FETCH) {
            val fetch = target?.fetch ?: return LimitStatus.None
            val rowCount: Expression = fetch.expression ?: return LimitStatus.None
            val value = (rowCount as? LongValue)?.value ?: return LimitStatus.NonLiteral
            if (value > maxRows) {
                return LimitStatus.High { fetch.expression = LongValue(maxRows.toLong()) }
            }
            return LimitStatus.Ok
        }
        val limit = target?.limit ?: return LimitStatus.None
        val rowCount: Expression = limit.rowCount ?: return LimitStatus.None
        val value = (rowCount as? LongValue)?.value ?: return LimitStatus.NonLiteral
        if (value > maxRows) {
            return LimitStatus.High { limit.rowCount = LongValue(maxRows.toLong()) }
        }
        return LimitStatus.Ok
    }
}
