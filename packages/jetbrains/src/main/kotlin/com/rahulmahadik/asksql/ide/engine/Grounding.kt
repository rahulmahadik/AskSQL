package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.SchemaCatalog

/**
 * Grounding: which identifier-shaped names in an answer are real, and whether the question asked
 * for a change at all. Mirrors core's `grounding.ts`; shared by the SQL and MongoDB pipelines.
 */
object Grounding {

    /** A request to add/change/remove schema objects or data. Third-person forms count ("a command that deletes"), past tenses do not. */
    val SCHEMA_CHANGE_RE = Regex(
        """\b(add|adds|adding|create|creates|creating|extend|extends|extending|alter|alters|altering|drop|drops|dropping|remove|removes|removing|delete|deletes|deleting|insert|inserts|inserting|update|updates|updating|truncate|truncates|truncating|rename|renames|renaming|migrate|migrates|migrating|introduce|introduces|introducing|modify|modifies|modifying)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** SQL an answer quotes as vocabulary, not as a name it claims exists. Identical to core's `grounding.ts` list (see tests/kotlin-parity-lists.test.ts). */
    private val SQL_VOCABULARY = setOf(
        "select", "from", "where", "join", "inner", "outer", "left", "right", "full", "cross", "on",
        "group", "order", "having", "limit", "offset", "fetch", "next", "rows", "row", "only", "ties",
        "union", "intersect", "except", "all", "distinct", "as", "and", "or", "not", "null", "nulls",
        "is", "in", "exists", "any", "some", "between", "like", "ilike", "similar", "escape", "case",
        "when", "then", "else", "end", "with", "recursive", "lateral", "natural", "using", "over",
        "partition", "window", "filter", "within", "asc", "desc", "collate", "order_by", "group_by",
        "is_null", "left_join", "inner_join", "outer_join", "cross_join", "insert", "update", "delete",
        "merge", "set", "values", "into", "returning", "explain", "create", "alter", "drop", "truncate",
        "rename", "add", "modify", "grant", "revoke", "begin", "commit", "rollback", "savepoint",
        "analyze", "vacuum", "table", "view", "materialized", "schema", "database", "column", "trigger",
        "function", "procedure", "sequence", "restrict", "on_delete", "on_update", "on_conflict",
        "count", "sum", "avg", "min", "max", "stddev", "variance", "array_agg", "string_agg",
        "json_agg", "jsonb_agg", "group_concat", "listagg", "row_number", "rank", "dense_rank",
        "percent_rank", "ntile", "lag", "lead", "first_value", "last_value", "nth_value", "cume_dist",
        "coalesce", "nullif", "ifnull", "isnull", "nvl", "decode", "iif", "greatest", "least", "cast",
        "convert", "extract", "substring", "substr", "trim", "ltrim", "rtrim", "upper", "lower",
        "initcap", "length", "char_length", "octet_length", "replace", "concat", "concat_ws",
        "position", "round", "floor", "ceil", "ceiling", "abs", "mod", "power", "sqrt", "random",
        "unnest", "generate_series", "json_extract", "json_build_object", "jsonb_build_object", "now",
        "date", "interval", "epoch", "age", "date_trunc", "date_part", "datediff", "dateadd", "to_char",
        "to_date", "to_number", "to_timestamp", "current_date", "current_time", "current_timestamp",
        "current_user", "localtime", "localtimestamp", "sysdate", "index", "constraint", "unique",
        "default", "check", "identity", "generated", "stored",
    )

    // Column types and constraint words that read like identifiers but never name a table or column.
    private val NON_IDENTIFIER_SNAKE = setOf(
        "primary_key", "foreign_key", "foreign_keys", "data_type", "data_types",
        "not_null", "auto_increment", "use_case", "read_only", "read_write",
        "integer", "int", "bigint", "smallint", "serial", "bigserial", "varchar", "char", "text",
        "boolean", "bool", "date", "time", "timestamp", "timestamptz", "numeric", "decimal", "real",
        "uuid", "json", "jsonb", "unique", "primary", "foreign", "constraint", "references", "index",
        "default", "cascade", "null", "column", "table",
    )

    /** MongoDB vocabulary that reads like an identifier but never names a collection or field: `$lookup` spec keys and stage options. */
    private val MONGO_NON_IDENTIFIER = setOf(
        "from", "localfield", "foreignfield", "as", "pipeline", "let", "into", "on", "cond", "input",
        "path", "output", "unit", "startdate", "enddate", "whenmatched", "whennotmatched", "depthfield",
        "preservenullandemptyarrays", "includearrayindex", "connectfromfield", "connecttofield", "maxdepth",
        "aggregate", "find", "sort", "limit", "skip", "count", "distinct", "collection", "document",
    )
    private val MONGO_OUTPUT_ALIAS_RE = Regex("""\bas\b\s*:?\s*["'`]?$""", RegexOption.IGNORE_CASE)

    /** Names the answer DEFINES with `AS`: output labels rather than claims that something exists. Only aliases in SQL context count. */
    private val ALIAS_RE = Regex("""\bas\s+(?:`([^`]+)`|"([^"]+)"|([a-z_]\w*))""", RegexOption.IGNORE_CASE)
    private val PROSE_AS_RE = Regex("""\b(such|known|same|referred to|serves|acts|described)\s+$""", RegexOption.IGNORE_CASE)
    // `with` must look like an actual CTE, not the English preposition.
    private val SQL_CONTEXT_RE =
        Regex("""\bselect\b|\bwith\s+(?:recursive\s+)?["`\w]+\s+as\s*\(""", RegexOption.IGNORE_CASE)

    /** The statement the alias sits in: back to the previous fence, blank line or `;`. */
    private fun statementBefore(text: String, index: Int): String {
        val start = maxOf(
            text.lastIndexOf("```", index),
            text.lastIndexOf("\n\n", index),
            text.lastIndexOf(';', index),
        )
        return text.substring(start + 1, index)
    }

    /** A CTE the answer defines itself: its own name, like a column alias, is not an invention. */
    private val CTE_DEF_RE = Regex("""\b([a-z_][\w$]*)\s+as\s*\(""", RegexOption.IGNORE_CASE)

    private fun definedAliases(answer: String): List<String> {
        val aliases = ALIAS_RE.findAll(answer).mapNotNull { m ->
            val before = statementBefore(answer, m.range.first)
            if (PROSE_AS_RE.containsMatchIn(before) || !SQL_CONTEXT_RE.containsMatchIn(before)) null
            else m.groupValues.drop(1).first { it.isNotEmpty() }.lowercase()
        }
        val ctes = CTE_DEF_RE.findAll(answer).map { it.groupValues[1].lowercase() }
        return (aliases + ctes).toList()
    }

    // Java's \s is ASCII-only where JavaScript's is not; these are the extras JS matches.
    // UNICODE_CHARACTER_CLASS would widen \w below and diverge the other way.
    private val PROSE_IDENTIFIER_RE = Regex(
        """`([^`\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+)`|"([\w.]+)"|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** An identifier, optionally schema-qualified. Placeholders, literals and operators do not match. */
    private val IDENTIFIER_SHAPE = Regex("""[a-z_][a-z0-9_$-]*(?:\.[a-z_][a-z0-9_$-]*)*""", RegexOption.IGNORE_CASE)

    /**
     * Identifier-shaped names in a prose answer absent from the catalog - the grounding floor for
     * `explainSchema`. Only snake_case and quoted/backticked tokens are checked.
     *
     * @param documentStyle MongoDB prose: `$lookup` is an operator and a double-quoted token is a VALUE.
     */
    /**
     * System catalogs and monitoring views: real objects outside the user's own schema. `pg_` and
     * `sqlite_` are reserved prefixes; Oracle's `user_`/`all_`/`dba_` are not, so those match by exact name only.
     */
    private val SYSTEM_CATALOG_RE = Regex(
        """^(?:pg_|sqlite_|v\$|gv\$|sys\.|mysql\.|information_schema\.|performance_schema\.)""",
        RegexOption.IGNORE_CASE,
    )

    private val SYSTEM_CATALOG_NAMES = (
        "information_schema performance_schema " +
            "user_tables user_indexes user_views user_constraints user_tab_columns user_ind_columns " +
            "user_objects user_sequences user_triggers user_procedures user_source user_tab_statistics " +
            "all_tables all_indexes all_views all_constraints all_tab_columns all_ind_columns all_objects " +
            "all_sequences all_triggers all_procedures all_source " +
            "dba_tables dba_indexes dba_views dba_constraints dba_tab_columns dba_objects dba_segments"
        ).split(" ").toSet()

    /** True for a real system object that is not part of the user's own schema. */
    private fun isSystemCatalog(name: String): Boolean {
        if (SYSTEM_CATALOG_RE.containsMatchIn(name)) return true
        val bare = if (name.contains('.')) name.substringAfterLast('.') else name
        return name in SYSTEM_CATALOG_NAMES || bare in SYSTEM_CATALOG_NAMES
    }

    fun unknownReferencesInProse(answer: String, catalog: SchemaCatalog, documentStyle: Boolean = false): List<String> {
        val known = HashSet<String>()
        for (s in catalog.schemas) known += s.lowercase()
        for (t in catalog.tables) {
            known += t.name.lowercase()
            if (t.schema != null) {
                known += t.schema.lowercase()
                known += "${t.schema.lowercase()}.${t.name.lowercase()}"
            }
            for (c in t.columns) known += c.name.lowercase()
        }
        for (alias in definedAliases(answer)) known += alias

        val found = LinkedHashSet<String>()
        // Document style: a fenced pipeline is syntax, not a name claim; SQL keeps its fences in scope.
        val scanned = if (documentStyle) answer.replace(Regex("```[\\s\\S]*?```"), " ") else answer
        for (m in PROSE_IDENTIFIER_RE.findAll(scanned)) {
            if (documentStyle && m.groupValues[2].isNotEmpty()) continue // "shipped" is a value
            // Backticks wrap anything, so a placeholder or a literal can arrive here.
            if (m.groupValues[1].isNotEmpty() && !IDENTIFIER_SHAPE.matches(m.groupValues[1])) continue
            val raw = (m.groupValues[1].ifEmpty { m.groupValues[2] }.ifEmpty { m.groupValues[3] }).lowercase()
            if (raw.startsWith("$")) continue // $lookup / $group are operators
            // Backticked SQL vocabulary is not a name claim; a call with parentheses is a function.
            if (raw.contains('(') || raw in SQL_VOCABULARY) continue
            if (raw.isEmpty() || raw in NON_IDENTIFIER_SNAKE) continue
            if (documentStyle && raw in MONGO_NON_IDENTIFIER) continue
            // `as: "customer_info"` names the join's OUTPUT, the document counterpart of a SQL alias.
            if (documentStyle && MONGO_OUTPUT_ALIAS_RE.containsMatchIn(scanned.substring(maxOf(0, m.range.first - 12), m.range.first))) continue
            val bare = if (raw.contains('.')) raw.substringAfterLast('.') else raw
            if (raw in known || bare in known) continue
            if (isSystemCatalog(raw)) continue
            found += raw
        }
        return found.toList()
    }

    /** True when the text names a table, view or column that really exists - i.e. it is an answer about this database. */
    /** Column names that are ordinary English first; on their own these never count as schema talk. */
    private val EVERYDAY_NAMES = setOf(
        "name", "date", "time", "type", "value", "status", "code", "text", "title", "number",
        "size", "level", "state", "key", "data", "user", "group", "count", "total", "amount",
        "active", "description", "comment", "label", "link", "file", "path", "note", "notes",
    )
    private val WORD_TOKEN_RE = Regex("""[a-z_][a-z0-9_$.]*""")

    fun mentionsCatalogName(text: String, catalog: SchemaCatalog): Boolean {
        // Whole-word matching, with a qualified reference counting as its parts too (`shop.orders` finds `orders`).
        val present = mutableSetOf<String>()
        for (token in WORD_TOKEN_RE.findAll(text.lowercase()).map { it.value }) {
            present.add(token)
            token.split('.').forEach { if (it.isNotEmpty()) present.add(it) }
        }
        fun counts(name: String): Boolean {
            val n = name.lowercase()
            if (n.length <= 2) return false
            // A name with an underscore or a schema qualifier is never accidental English.
            if (!n.contains('_') && EVERYDAY_NAMES.contains(n)) return false
            return present.contains(n)
        }
        for (t in catalog.tables) {
            if (counts(t.name)) return true
            for (c in t.columns) if (counts(c.name)) return true
        }
        return false
    }
}
