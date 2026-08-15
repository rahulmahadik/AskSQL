package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.DialectInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind

/**
 * Mirrors packages/core/src/catalog-answers.ts: structure questions answered with SQL written here
 * rather than guessed by a model, which invents columns on `information_schema` and `pg_stat_*`.
 *
 * Always a statement, never a cached answer: the catalog supplies only names, and it can be minutes
 * stale where a query cannot.
 */
object CatalogAnswers {

    data class CatalogQuery(val sql: String, val explanation: String)

    private val EVERY_TABLE = Regex("""\b(each|every|per|all)\s+(?:the\s+)?tables?\b""", RegexOption.IGNORE_CASE)
    private val ROWS = Regex("""\b(rows?|records?)\b""", RegexOption.IGNORE_CASE)
    private val MOST_ROWS = Regex(
        """\b(most|largest|biggest|highest)\b[^.?!]{0,24}\b(rows?|records?)\b|\b(rows?|records?)\b[^.?!]{0,24}\b(most|largest|biggest)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val NEGATED = Regex(
        """\b(without|no|missing|lack(?:ing|s)?|do(?:es)?\s*n[o']?t have|have no)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val TABLES = Regex("""\btables?\b""", RegexOption.IGNORE_CASE)
    private val PRIMARY_KEY = Regex("""\bprimary\s+keys?\b|\bpk\b""", RegexOption.IGNORE_CASE)

    /** The subject has to be tables. "which rows ... have no pk" asks about rows in one table. */
    private val TABLE_SUBJECT =
        Regex("""\b(?:which|what|list|show|find|any)\b[^.?!]{0,24}\btables?\b""", RegexOption.IGNORE_CASE)
    private val ROW_SUBJECT = Regex("""\b(?:rows?|records?)\b""", RegexOption.IGNORE_CASE)

    /** "the orders table" names one table, so the question is about its rows, not about every table. */
    private val NAMED_TABLE =
        Regex("""\b(?:the|this|that|a|an|our|my)\s+[\w"`\]]+\s+tables?\b""", RegexOption.IGNORE_CASE)
    private val ROW_CONDITION =
        Regex("""\b(?:where|that (?:are|have)|with a|having)\b""", RegexOption.IGNORE_CASE)

    private fun qualified(t: TableInfo): String = if (t.schema != null) "${t.schema}.${t.name}" else t.name

    /** Views have no rows of their own, and a partition is counted through its parent. */
    private fun countableTables(catalog: SchemaCatalog): List<TableInfo> =
        catalog.tables.filter { it.kind == TableKind.TABLE && it.partitionOf == null }

    private fun quoteFor(name: String, dialect: DialectInfo): String {
        val q = dialect.quoteChar
        return "$q${name.replace(q.toString(), "$q$q")}$q"
    }

    /**
     * Tables with no primary key, in each engine's own catalog. Written per engine because this is
     * exactly where a model guesses: every engine exposes it differently.
     */
    private fun tablesWithoutPrimaryKey(engine: EngineKind, schemas: List<String>): String? {
        // The catalog spans every schema introspected, so answering for current_schema() alone
        // reports a narrower truth than the schema tree the reader is looking at.
        val inList = if (schemas.isNotEmpty()) schemas.joinToString(", ") { "'" + it.replace("'", "''") + "'" } else "current_schema()"
        return when (engine) {
        EngineKind.POSTGRES ->
            """
            SELECT t.table_name
            FROM information_schema.tables t
            WHERE t.table_schema IN ($inList)
              AND t.table_type = 'BASE TABLE'
              AND NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints c
                WHERE c.table_schema = t.table_schema
                  AND c.table_name = t.table_name
                  AND c.constraint_type = 'PRIMARY KEY'
              )
            ORDER BY t.table_name
            """.trimIndent()
        EngineKind.MYSQL ->
            """
            SELECT t.TABLE_NAME
            FROM information_schema.TABLES t
            WHERE t.TABLE_SCHEMA = DATABASE()
              AND t.TABLE_TYPE = 'BASE TABLE'
              AND NOT EXISTS (
                SELECT 1 FROM information_schema.TABLE_CONSTRAINTS c
                WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA
                  AND c.TABLE_NAME = t.TABLE_NAME
                  AND c.CONSTRAINT_TYPE = 'PRIMARY KEY'
              )
            ORDER BY t.TABLE_NAME
            """.trimIndent()
        EngineKind.ORACLE ->
            """
            SELECT t.table_name
            FROM user_tables t
            WHERE NOT EXISTS (
              SELECT 1 FROM user_constraints c
              WHERE c.table_name = t.table_name AND c.constraint_type = 'P'
            )
            ORDER BY t.table_name
            """.trimIndent()
        EngineKind.SQLITE ->
            """
            SELECT m.name
            FROM sqlite_master m
            WHERE m.type = 'table'
              AND m.name NOT LIKE 'sqlite_%'
              AND NOT EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.pk > 0)
            ORDER BY m.name
            """.trimIndent()
        // Anything else: let the model try rather than guess a shape here.
            else -> null
        }
    }

    /**
     * Returns a statement for the structure questions worth writing exactly, or null for everything
     * else, which is the common case. Matching is narrow: hijacking a data question is far worse
     * than missing one of these.
     */
    fun catalogQueryFor(question: String, catalog: SchemaCatalog, dialect: DialectInfo): CatalogQuery? {
        val q = question.trim()
        if (!TABLES.containsMatchIn(q)) return null

        if (NEGATED.containsMatchIn(q) && PRIMARY_KEY.containsMatchIn(q) &&
            TABLE_SUBJECT.containsMatchIn(q) && !ROW_SUBJECT.containsMatchIn(q)
        ) {
            val schemas = catalog.tables.mapNotNull { it.schema }.distinct()
            tablesWithoutPrimaryKey(dialect.engine, schemas)?.let {
                return CatalogQuery(it, "Lists tables with no primary key, read from the database catalog.")
            }
        }

        // Row counts, one branch per table. A model writes this as an information_schema join and
        // gets an ambiguous column, or reaches for a statistics view whose columns it has guessed.
        // Naming a table makes it a data question about that table's rows, not a count of all.
        if (NAMED_TABLE.containsMatchIn(q) ||
            catalog.tables.any { Regex("\\b" + Regex.escape(it.name) + "\\b", RegexOption.IGNORE_CASE).containsMatchIn(q) }
        ) {
            return null
        }
        // A condition on the rows makes it a data question about rows, not a count of every table.
        if (NEGATED.containsMatchIn(q) || ROW_CONDITION.containsMatchIn(q)) return null
        if ((EVERY_TABLE.containsMatchIn(q) && ROWS.containsMatchIn(q)) || MOST_ROWS.containsMatchIn(q)) {
            val tables = countableTables(catalog)
            if (tables.isEmpty()) return null
            val branches = tables.map { t ->
                val label = qualified(t).replace("'", "''")
                val from = if (t.schema != null) {
                    "${quoteFor(t.schema, dialect)}.${quoteFor(t.name, dialect)}"
                } else {
                    quoteFor(t.name, dialect)
                }
                "SELECT '$label' AS table_name, COUNT(*) AS row_count FROM $from"
            }
            val body = branches.joinToString("\nUNION ALL\n")
            // Always ordered: the guard appends its row cap, and an unordered UNION ALL truncated to
            // the cap drops tables at random while the explanation claims to have counted them all.
            val sql = "SELECT * FROM (\n$body\n) counts ORDER BY row_count DESC"
            return CatalogQuery(sql, "Counts the rows in each of the ${tables.size} tables, largest first.")
        }

        return null
    }
}
