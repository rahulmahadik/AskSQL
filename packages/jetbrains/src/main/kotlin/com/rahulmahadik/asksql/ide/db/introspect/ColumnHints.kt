package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import java.sql.Connection

/**
 * What a column's TYPE does not say, stated in its comment so the model does not have to guess.
 *
 * Two gaps, both measured as answers that are wrong with no error:
 *  - an integer column holding a moment carries no unit, so epoch milliseconds compared against epoch
 *    seconds matches every row (measured on Postgres: 3 returned, 2 true) and against a text date none;
 *  - a JSON column carries no key names, so the model invents one and the filter matches nothing.
 *
 * Shared by every JDBC introspector, and kept identical to packages/core/src/column-hints.ts, which
 * HintParityTest asserts against the vectors in tools/parity/vectors/hints.json. Only the probe SQL and
 * the accessor differ per engine; the judgement does not.
 */
object ColumnHints {

    /** A shared cap, so a wide schema cannot turn a catalog read into a scan. */
    private const val MAX_PROBES = 200

    /** Per table, so a wide schema degrades evenly instead of the first tables taking every probe. */
    private const val MAX_PROBES_PER_TABLE = 4

    /**
     * The per-table probe share for a schema of [tableCount] tables, so the global cap spreads evenly
     * instead of the first tables spending it all. Matches packages/core/src/column-hints.ts.
     */
    internal fun probesPerTable(tableCount: Int): Int =
        maxOf(1, minOf(MAX_PROBES_PER_TABLE, MAX_PROBES / maxOf(1, tableCount)))

    private const val JSON_SAMPLE_ROWS = 20
    private const val JSON_MAX_KEYS = 12
    private const val JSON_MIN_ROWS_TO_NAME = 3
    private const val JSON_KEY_SHARE = 0.4

    /** Leaves room for CatalogPruner's own 200-character comment cap. */
    private const val HINT_CAP = 185

    private val TIMEISH_NAME = Regex(
        "(?:^|_)(?:at|ts|time|date|timestamp|created|updated|modified|deleted|expires?|expiry|last_seen|since|until)(?:_|$)|(?:time|date|timestamp)$",
        RegexOption.IGNORE_CASE,
    )

    /** An identifier, never a moment: `created_by_employee_id` matches the name test but holds an id. */
    private val ID_NAME = Regex("(?:^|_)(?:id|ids|key|uuid|guid|hash|no|num|number|code|by)$", RegexOption.IGNORE_CASE)

    /** A fixed-scale number is a measurement, not a moment: `amount_due numeric(14,2)` is money. */
    private val HAS_SCALE = Regex("""\(\s*\d+\s*,\s*[1-9]\d*\s*\)""")

    private val INTEGERISH = Regex(
        "^(?:big\\s*int|int|integer|int2|int4|int8|smallint|tinyint|mediumint|unsigned\\s+big\\s+int|numeric|number|decimal)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val TEXTISH = Regex("^(?:json|jsonb|text|longtext|mediumtext|tinytext|varchar|character varying|citext|char|clob|nclob|nvarchar|string)", RegexOption.IGNORE_CASE)

    /** A key that reads as a field name. One that does not is data: a map keyed by an address or an id. */
    private val JSON_KEY = Regex("^[A-Za-z_][A-Za-z0-9_]{0,39}$")

    /**
     * `due`, `start`, `end`, `sent` and `received` are left out of TIMEISH_NAME on purpose: alone they
     * are `amount_due`, `month_end`, `quantity_sent`. Paired with a real time word (`due_at`,
     * `start_date`) they still match, so nothing genuine is lost.
     */
    fun isMoment(name: String, dbType: String): Boolean {
        val type = dbType.trim()
        return INTEGERISH.containsMatchIn(type) &&
            !HAS_SCALE.containsMatchIn(type) &&
            TIMEISH_NAME.containsMatchIn(name) &&
            !ID_NAME.containsMatchIn(name)
    }

    /** At or above this a value is a sentinel, not a moment: Long.MAX_VALUE means "never expires". */
    private const val SENTINEL_FLOOR = 9e18

    private fun bucketOf(v: Double): String? = when {
        v >= 1e17 -> "epoch nanoseconds"
        v >= 1e14 -> "epoch microseconds"
        v >= 1e11 -> "epoch milliseconds"
        v >= 1e8 -> "epoch seconds"
        else -> null // too small to be a modern timestamp; saying nothing beats guessing
    }

    /**
     * Which epoch unit a column is in, from its range rather than one end of it. A single MAX() is
     * decided by the largest row, so a "never expires" sentinel reported nanoseconds for an ordinary
     * milliseconds column, and one legacy millisecond row among seconds reported milliseconds for all of
     * them. When the ends disagree the column is mixed and the honest hint is none.
     */
    fun epochUnitOf(lo: Double?, hi: Double? = lo): String? {
        if (lo == null || hi == null || !lo.isFinite() || !hi.isFinite() || lo <= 0) return null
        // A sentinel is not a moment; ignore it and judge by the rest of the range.
        val top = if (hi >= SENTINEL_FLOOR) lo else hi
        val bucket = bucketOf(lo)
        return if (bucket != null && bucket == bucketOf(top)) bucket else null
    }

    /**
     * Null when the column does not hold JSON objects; an empty list when it does but nothing is nameable.
     * Only keys that RECUR are named: a record repeats its keys, a map keyed by data does not, so
     * `{"ZZALICE":3}, {"ZZBOB":7}` yields no stable key and the usernames never reach the prompt. Known
     * residual: a fixed set of identifier-shaped keys present on most rows still reads as a record.
     */
    fun jsonShapeOf(values: List<String>): List<String>? {
        val seenIn = LinkedHashMap<String, Int>()
        var parsed = 0
        for (raw in values) {
            val text = raw.trim()
            if (!text.startsWith("{")) return null
            val keys = JsonKeys.topLevel(text) ?: return null
            for (k in keys) {
                if (!JSON_KEY.matches(k)) return null
                seenIn[k] = (seenIn[k] ?: 0) + 1
            }
            parsed++
        }
        if (parsed == 0) return null
        if (parsed < JSON_MIN_ROWS_TO_NAME) return emptyList()
        val needed = maxOf(2.0, parsed * JSON_KEY_SHARE)
        val stable = seenIn.filterValues { it >= needed }.keys.toList()
        return if (stable.size in 2..JSON_MAX_KEYS) stable else emptyList()
    }

    /** The element type of a JSON ARRAY column: real schemas keep lists of ids as `[123504,312]`. */
    fun jsonArrayElementOf(values: List<String>): String? {
        var seen: String? = null
        var parsed = 0
        for (raw in values) {
            val element = JsonKeys.arrayElement(raw.trim()) ?: return null
            if (element == "mixed") return null
            if (element != "empty") {
                if (seen != null && seen != element) return null
                seen = element
            }
            parsed++
        }
        return if (parsed > 0) seen else null
    }

    /**
     * The hint as the model is shown it. The key NAMES are gated: a map with a stable key set - per-user
     * scores, per-tenant flags - has perfect recurrence and so scores maximally as a record, and no
     * threshold separates the two. The names therefore ride the same opt-in as every other cell value,
     * while the accessor, which is what stopped the model reaching for LIKE, is always safe to state.
     * The list is trimmed at a key boundary so the comment cap never cuts a name in half.
     */
    fun jsonHint(accessor: String, keys: List<String>, nameKeys: Boolean = false): String {
        val prefix = "JSON object, read with $accessor"
        if (keys.isEmpty()) return prefix
        if (!nameKeys) return "$prefix (${keys.size} recurring ${if (keys.size == 1) "key" else "keys"})"
        val lead = "$prefix; keys: "
        val kept = mutableListOf<String>()
        for (k in keys) {
            if (lead.length + (kept + k).joinToString(", ").length > HINT_CAP) break
            kept += k
        }
        val shown = kept.ifEmpty { keys.take(1) }
        return lead + shown.joinToString(", ") + if (shown.size < keys.size) ", ..." else ""
    }

    /** How one engine spells the things that differ; the judgement above is shared. */
    data class Syntax(
        val quote: (String) -> String,
        val jsonAccessor: (String) -> String,
        val arrayMembership: (String, String) -> String,
        val limit: (String, Int) -> String,
    )

    fun syntaxFor(engine: EngineKind): Syntax {
        val dq: (String) -> String = { "\"${it.replace("\"", "\"\"")}\"" }
        return when (engine) {
            EngineKind.MYSQL -> Syntax(
                quote = { "`${it.replace("`", "``")}`" },
                jsonAccessor = { "`${it.replace("`", "``")}`->>'\$.key'" },
                arrayMembership = { col, el -> "JSON_CONTAINS(`${col.replace("`", "``")}`, '${if (el == "number") "1" else "\"a\""}')" },
                limit = { sql, n -> "$sql LIMIT $n" },
            )
            // Oracle has no LIMIT and would raise ORA-00933.
            EngineKind.ORACLE -> Syntax(
                quote = dq,
                jsonAccessor = { "JSON_VALUE(${dq(it)}, '\$.key')" },
                arrayMembership = { col, el -> "JSON_EXISTS(${dq(col)}, '\$?(@ == ${if (el == "number") "1" else "\"a\""})')" },
                limit = { sql, n -> "$sql FETCH FIRST $n ROWS ONLY" },
            )
            EngineKind.DUCKDB -> Syntax(
                quote = dq,
                jsonAccessor = { "${dq(it)}->>'\$.key'" },
                // list_contains does not bind on the VARCHAR/JSON columns this hint is attached to.
                arrayMembership = { col, el -> "json_contains(${dq(col)}, '${if (el == "number") "1" else "\"a\""}')" },
                limit = { sql, n -> "$sql LIMIT $n" },
            )
            EngineKind.SQLITE -> Syntax(
                quote = dq,
                jsonAccessor = { "json_extract(${dq(it)}, '\$.key')" },
                arrayMembership = { col, el ->
                    "EXISTS (SELECT 1 FROM json_each(${dq(col)}) WHERE value = ${if (el == "number") "1" else "'a'"})"
                },
                limit = { sql, n -> "$sql LIMIT $n" },
            )
            // ->> and @> are defined on json/jsonb only: on a text column they raise
            // "operator does not exist: text ->> unknown", so the hint would teach SQL that cannot run.
            else -> Syntax(
                quote = dq,
                jsonAccessor = { "(${dq(it)})::jsonb->>'key'" },
                arrayMembership = { col, el -> "(${dq(col)})::jsonb @> '${if (el == "number") "1" else "\"a\""}'" },
                limit = { sql, n -> "$sql LIMIT $n" },
            )
        }
    }

    /**
     * Annotates every describable column, bounded by [MAX_PROBES]. A comment the DBA wrote is never
     * overwritten, and a view is skipped because sampling one runs its query.
     */
    fun annotate(
        connection: Connection,
        engine: EngineKind,
        tables: List<TableInfo>,
        nameKeys: Boolean = false,
    ): List<TableInfo> {
        val s = syntaxFor(engine)
        var total = MAX_PROBES
        val perTable = probesPerTable(tables.size)
        return tables.map { table ->
            if (table.kind == TableKind.VIEW || total <= 0) return@map table
            var budget = minOf(perTable, total)
            val rel = table.schema?.let { "${s.quote(it)}.${s.quote(table.name)}" } ?: s.quote(table.name)
            val columns = table.columns.map inner@{ col ->
                val moment = isMoment(col.name, col.dbType)
                val textish = TEXTISH.containsMatchIn(col.dbType.trim())
                if (budget <= 0 || col.comment != null || (!moment && !textish)) return@inner col
                budget--
                total--
                try {
                    if (moment) {
                        val ends = pair(
                            connection,
                            "SELECT MIN(${s.quote(col.name)}), MAX(${s.quote(col.name)}) FROM $rel",
                        )
                        epochUnitOf(ends?.first?.toDoubleOrNull(), ends?.second?.toDoubleOrNull())
                            ?.let { col.copy(comment = it) } ?: col
                    } else {
                        val sql = s.limit(
                            "SELECT ${s.quote(col.name)} FROM $rel WHERE ${s.quote(col.name)} IS NOT NULL",
                            JSON_SAMPLE_ROWS,
                        )
                        val values = all(connection, sql)
                        val shape = if (values.isEmpty()) null else jsonShapeOf(values)
                        val element = if (shape != null || values.isEmpty()) null else jsonArrayElementOf(values)
                        when {
                            shape != null -> col.copy(comment = jsonHint(s.jsonAccessor(col.name), shape, nameKeys))
                            element != null ->
                                col.copy(
                                    comment = "JSON array of ${element}s; test membership with " +
                                        s.arrayMembership(col.name, element),
                                )
                            else -> col
                        }
                    }
                } catch (e: Exception) {
                    col // best-effort: an unreadable column simply goes undescribed
                }
            }
            table.copy(columns = columns)
        }
    }

    /** Both ends of a range in one round trip; see epochUnitOf for why one end is not enough. */
    private fun pair(connection: Connection, sql: String): Pair<String?, String?>? =
        connection.createStatement().use { st ->
            st.queryTimeout = PROBE_TIMEOUT_SECONDS
            st.executeQuery(sql).use { rs -> if (rs.next()) rs.getString(1) to rs.getString(2) else null }
        }

    /** Seconds a single probe may take. */
    private const val PROBE_TIMEOUT_SECONDS = 2

    private fun all(connection: Connection, sql: String): List<String> =
        connection.createStatement().use { st ->
            // Without this a MAX() over a large unindexed table runs until the driver's socket timeout,
            // which CLOSES the connection: the per-column catch then probes a dead one and the caller
            // loses the whole catalog. Networked engines never ran probe SQL before these hints existed.
            st.queryTimeout = PROBE_TIMEOUT_SECONDS
            st.executeQuery(sql).use { rs ->
                buildList { while (rs.next()) rs.getString(1)?.let { add(it) } }
            }
        }
}
