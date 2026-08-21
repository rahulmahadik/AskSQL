package com.rahulmahadik.asksql.ide.model

/** Built-in engine identifiers; core's `EngineKind` as a closed enum. */
enum class EngineKind {
    POSTGRES,
    MYSQL,
    SQLITE,
    DUCKDB,
    ORACLE,
    MONGODB,
    ;

    val wireName: String
        get() = name.lowercase()

    /** False only for [MONGODB]; routes around JDBC/SQL-specific code instead of each call site re-deriving it. */
    val isSql: Boolean
        get() = this != MONGODB

    companion object {
        fun fromWireName(value: String): EngineKind =
            entries.firstOrNull { it.wireName == value.lowercase() }
                ?: throw IllegalArgumentException("Unknown engine: $value")
    }
}

/** Pagination form the model should use in generated SQL. */
enum class LimitStyle { LIMIT, TOP, FETCH }

/**
 * Everything the prompt builder and guard need to know about a SQL dialect.
 * Behavior differences flow through here rather than engine-specific `if`s elsewhere (core's `DialectInfo` equivalent).
 */
data class DialectInfo(
    val engine: EngineKind,
    /** Identifier quote character used when generating SQL hints. */
    val quoteChar: Char,
    /** Human-readable dialect label injected into prompts, e.g. "PostgreSQL 16". */
    val promptLabel: String,
    val limitStyle: LimitStyle,
    val promptNotes: List<String> = emptyList(),
)

// promptNotes are ported verbatim from `@asksql/core`'s `dialects.ts`; PromptParityTest
// asserts them byte-identical against the published package. Never paraphrase these strings.
object Dialects {
    /**
     * ColumnHints stamps an integer moment column with the unit it holds, which the type never states.
     * Without this the unit is named and then ignored: milliseconds compared against a seconds bound
     * match every row. SQLite says the same thing in its own longer note, so it does not repeat this one.
     */
    private const val EPOCH_UNIT_NOTE =
        "When a column comment names an epoch unit, build the bound in THAT SAME unit and no other. " +
            "For 'epoch seconds' compare against a seconds bound unchanged; for 'epoch milliseconds' " +
            "multiply the seconds bound by 1000. Mixing them raises no error: milliseconds against a " +
            "seconds bound matches every row, and seconds against a milliseconds bound matches none."

    val POSTGRES = DialectInfo(
        engine = EngineKind.POSTGRES,
        quoteChar = '"',
        promptLabel = "PostgreSQL",
        limitStyle = LimitStyle.LIMIT,
        promptNotes = listOf(
            EPOCH_UNIT_NOTE,
            "Quote mixed-case or reserved identifiers with double quotes.",
            "Use ILIKE for case-insensitive text matching.",
            "Combine values into one string with string_agg(col, ', ').",
            "Use date_trunc / interval arithmetic for date math (e.g. now - interval '30 days').",
        ),
    )

    val MYSQL = DialectInfo(
        engine = EngineKind.MYSQL,
        quoteChar = '`',
        promptLabel = "MySQL",
        limitStyle = LimitStyle.LIMIT,
        promptNotes = listOf(
            EPOCH_UNIT_NOTE,
            "Quote identifiers with backticks when needed.",
            "Use DATE_SUB / DATE_ADD / DATE_FORMAT for date math.",
            "Combine values into one string with GROUP_CONCAT(col SEPARATOR ', ').",
        ),
    )

    val SQLITE = DialectInfo(
        engine = EngineKind.SQLITE,
        quoteChar = '"',
        promptLabel = "SQLite",
        limitStyle = LimitStyle.LIMIT,
        promptNotes = listOf(
            "Dates: a TEXT column holds ISO text, so compare it with date/datetime/strftime " +
                "(e.g. date('now','-30 days')). An INTEGER column holds a number - usually epoch seconds, or " +
                "milliseconds if the values are ~1000x larger - so build the bound as a number in the SAME " +
                "units, e.g. (strftime('%s','now') - 30*86400) * 1000 for milliseconds. Never compare an " +
                "INTEGER column with a text date: nothing matches and no error is raised.",
            "There are no schemas; refer to tables by bare name.",
            "Combine values into one string with group_concat(col, ', ').",
        ),
    )

    val DUCKDB = DialectInfo(
        engine = EngineKind.DUCKDB,
        quoteChar = '"',
        promptLabel = "DuckDB",
        limitStyle = LimitStyle.LIMIT,
        promptNotes = listOf(
            EPOCH_UNIT_NOTE,
            "DuckDB follows PostgreSQL syntax for queries.",
            "Combine values into one string with string_agg(col, ', '); SEPARATOR is MySQL syntax and is rejected here.",
            "Uploaded files are already registered as tables - query them by table name, never by file path.",
        ),
    )

    /**
     * Ported verbatim from `@asksql/core`'s ORACLE_DIALECT, order included. These notes had told the
     * model to write `FETCH FIRST` while core told it to write no row limit at all; the guard caps rows
     * either way, so only the instruction differed. PromptParityTest now covers every engine, not just
     * PostgreSQL, which is what let this drift.
     */
    val ORACLE = DialectInfo(
        engine = EngineKind.ORACLE,
        quoteChar = '"',
        promptLabel = "Oracle",
        limitStyle = LimitStyle.FETCH,
        promptNotes = listOf(
            EPOCH_UNIT_NOTE,
            "Do not add a row limit clause (no FETCH FIRST, no ROWNUM, no LIMIT). Order the results and the system returns the top rows.",
            "Use TO_DATE / TO_CHAR / SYSDATE and interval arithmetic for date math.",
            "Unquoted identifiers are case-insensitive and stored upper case; double-quote to preserve case.",
            "Select a literal from the DUAL table (e.g. SELECT 1 FROM DUAL), not a bare SELECT 1.",
            "There is no boolean type; a comparison is not a directly selectable value.",
            "The safety validator cannot read LISTAGG ... WITHIN GROUP, so return the rows themselves rather than combining them into one string.",
        ),
    )

    fun of(engine: EngineKind): DialectInfo = when (engine) {
        EngineKind.POSTGRES -> POSTGRES
        EngineKind.MYSQL -> MYSQL
        EngineKind.SQLITE -> SQLITE
        EngineKind.DUCKDB -> DUCKDB
        EngineKind.ORACLE -> ORACLE
        EngineKind.MONGODB -> error("MongoDB has no SQL dialect - routed to MongoEnginePipeline before this is ever called")
    }
}
