package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import java.io.File
import java.sql.Connection

/**
 * Loads a user-supplied file into DuckDB as queryable tables. A .sql dump is executed after
 * [validateSqlDump] only (the user trusts their own file, not an LLM); every other format becomes a read-only VIEW via `read_*`.
 */
object DuckDbFileLoader {

    enum class FileFormat { CSV, JSON, NDJSON, PARQUET, XLSX, SQL }

    /** The catalog table this loader uses to remember which tables came from a file (read by [com.rahulmahadik.asksql.ide.db.introspect.DuckDbIntrospector]). */
    const val UPLOAD_MARKER_TABLE = "_asksql_file_uploads"

    private val RESERVED_TABLE_NAMES = setOf(
        "order", "group", "select", "from", "where", "table", "user", "join", "on", "having",
        "limit", "offset", "union", "all", "and", "or", "not", "null", "as", "by", "into", "values",
        "set", "case", "when", "then", "else", "end", "semi", "anti", "asof", "using", "natural",
        "cross", "inner", "outer", "left", "right", "full", "distinct", "exists", "in", "is", "like",
        "between", "desc", "asc", "pivot", "unpivot", "window", "qualify", "sample", "exclude",
    )

    fun resolveFormat(path: String): FileFormat {
        val lower = path.lowercase()
        return when {
            lower.endsWith(".parquet") -> FileFormat.PARQUET
            lower.endsWith(".xlsx") || lower.endsWith(".xls") -> FileFormat.XLSX
            lower.endsWith(".ndjson") -> FileFormat.NDJSON
            lower.endsWith(".json") -> FileFormat.JSON
            lower.endsWith(".sql") -> FileFormat.SQL
            else -> FileFormat.CSV
        }
    }

    /** Makes a safe SQL identifier from a user filename. */
    fun sanitizeTableName(raw: String): String {
        val base = raw.replace(Regex("""\.[^.]+$"""), "").replace(Regex("""[^A-Za-z0-9_]"""), "_")
        var cleaned = if (Regex("""^[A-Za-z_]""").containsMatchIn(base)) base else "t_$base"
        if (cleaned.lowercase() in RESERVED_TABLE_NAMES) cleaned = "${cleaned}_data"
        return cleaned.take(63).ifEmpty { "t_file" }
    }

    private fun quoteIdent(name: String) = "\"${name.replace("\"", "\"\"")}\""
    private fun sqlStr(s: String) = "'${s.replace("'", "''")}'"

    /**
     * Registered paths must be plain local paths: a URL scheme makes DuckDB fetch over the network
     * (SSRF risk), and a glob metacharacter fans one registration out to many files.
     */
    fun assertSafeFilePath(path: String, allowRemote: Boolean = false, allowGlob: Boolean = false) {
        if (!allowRemote && Regex("""^[a-z][a-z0-9+.-]*://""", RegexOption.IGNORE_CASE).containsMatchIn(path)) {
            throw AskSqlException(
                AskSqlErrorCode.FILE_LOAD_ERROR,
                userMessage = "\"${File(path).name}\" is a URL. Loading a file over the network isn't allowed.",
            )
        }
        if (!allowGlob && Regex("""[*?\[\]{}]""").containsMatchIn(path)) {
            throw AskSqlException(
                AskSqlErrorCode.FILE_LOAD_ERROR,
                userMessage = "\"${File(path).name}\" contains a wildcard, which isn't allowed.",
            )
        }
    }

    /**
     * Pre-checks an executed (not read-only-guarded) .sql upload: reject vendor dumps DuckDB can't
     * parse, and statements reaching the filesystem/network/extensions. What survives is structure plus data.
     */
    fun validateSqlDump(content: String) {
        if (Regex("`").containsMatchIn(content) || Regex("""\bENGINE\s*=""", RegexOption.IGNORE_CASE).containsMatchIn(content) || Regex("""/\*!\d""").containsMatchIn(content)) {
            throw AskSqlException(
                AskSqlErrorCode.FILE_LOAD_ERROR,
                userMessage = "This looks like a MySQL (mysqldump) file, which cannot be loaded directly. Re-export it as CSV, or as portable SQL - plain CREATE TABLE and INSERT statements.",
                detail = "mysqldump syntax detected in .sql upload",
            )
        }
        if (Regex("""\bCOPY\b[\s\S]*?\bFROM\s+stdin""", RegexOption.IGNORE_CASE).containsMatchIn(content) ||
            Regex("""^\s*\\[.]""", RegexOption.MULTILINE).containsMatchIn(content) ||
            Regex("""^\s*\\connect\b""", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)).containsMatchIn(content)
        ) {
            throw AskSqlException(
                AskSqlErrorCode.FILE_LOAD_ERROR,
                userMessage = "This looks like a PostgreSQL (pg_dump) file, which cannot be loaded directly. Re-export it as CSV, or with \"pg_dump --inserts\" so it uses plain INSERT statements.",
                detail = "pg_dump syntax detected in .sql upload",
            )
        }
        val danger = Regex("""\b(ATTACH|INSTALL|LOAD|COPY)\b""", RegexOption.IGNORE_CASE).find(content)
            ?: Regex("""\b(read_csv|read_parquet|read_json|read_ndjson|read_text|glob)\s*\(""", RegexOption.IGNORE_CASE).find(content)
        if (danger != null) {
            val keyword = danger.groupValues.getOrNull(1)?.ifEmpty { danger.value } ?: danger.value
            throw AskSqlException(
                AskSqlErrorCode.FILE_LOAD_ERROR,
                userMessage = "This SQL file uses \"${keyword.uppercase()}\", which is not allowed in an uploaded file - it could read other files or reach the network. Uploaded SQL may only create tables and insert data.",
                detail = "disallowed statement in .sql upload: ${danger.value}",
            )
        }
    }

    /** SQL reader table-function expression for a non-.sql file format. */
    private fun readerFor(path: String, format: FileFormat, encoding: String?, sheet: String?): String {
        val p = sqlStr(path)
        return when (format) {
            FileFormat.SQL -> error("readerFor called for sql format")
            FileFormat.PARQUET -> "read_parquet($p)"
            FileFormat.JSON, FileFormat.NDJSON -> "read_json_auto($p)"
            FileFormat.XLSX -> if (sheet != null) "read_xlsx($p, sheet = ${sqlStr(sheet)})" else "read_xlsx($p)"
            FileFormat.CSV -> if (encoding != null) "read_csv_auto($p, encoding=${sqlStr(encoding)})" else "read_csv_auto($p)"
        }
    }

    private fun ensureMarkerTable(connection: Connection) {
        connection.createStatement().use { st ->
            st.execute("CREATE TABLE IF NOT EXISTS ${quoteIdent(UPLOAD_MARKER_TABLE)} (table_name TEXT PRIMARY KEY)")
        }
    }

    private fun markAsFileSourced(connection: Connection, tableNames: Collection<String>) {
        if (tableNames.isEmpty()) return
        connection.createStatement().use { st ->
            for (name in tableNames) {
                st.execute("INSERT OR IGNORE INTO ${quoteIdent(UPLOAD_MARKER_TABLE)} VALUES (${sqlStr(name)})")
            }
        }
    }

    private fun tableNames(connection: Connection): Set<String> {
        val names = mutableSetOf<String>()
        connection.createStatement().use { st ->
            st.executeQuery("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'").use { rs ->
                while (rs.next()) names += rs.getString("table_name")
            }
        }
        return names
    }

    /**
     * Loads [filePath] into [connection] (a WRITABLE DuckDB connection, never the plugin's read-only
     * query connection) and returns the table name(s) created. The connection must not be shared with an in-flight query.
     */
    fun loadFile(
        connection: Connection,
        filePath: String,
        tableNameHint: String? = null,
        encoding: String? = null,
        sheet: String? = null,
        allowRemote: Boolean = false,
        allowGlob: Boolean = false,
    ): List<String> {
        assertSafeFilePath(filePath, allowRemote, allowGlob)
        ensureMarkerTable(connection)
        val format = resolveFormat(filePath)

        if (format == FileFormat.SQL) {
            val content = try {
                File(filePath).readText(Charsets.UTF_8)
            } catch (e: Exception) {
                throw AskSqlException(AskSqlErrorCode.FILE_LOAD_ERROR, userMessage = "Couldn't read \"${File(filePath).name}\": ${e.message}", detail = e.message, cause = e)
            }
            validateSqlDump(content)
            val before = tableNames(connection)
            try {
                connection.createStatement().use { st -> st.execute(content) }
            } catch (e: Exception) {
                throw AskSqlException(AskSqlErrorCode.FILE_LOAD_ERROR, userMessage = "Couldn't load \"${File(filePath).name}\": ${e.message}", detail = e.message, cause = e)
            }
            val created = tableNames(connection) - before
            if (created.isEmpty()) {
                throw AskSqlException(
                    AskSqlErrorCode.FILE_LOAD_ERROR,
                    userMessage = "\"${File(filePath).name}\" ran but created no tables. An uploadable SQL file must CREATE TABLE and INSERT its data.",
                )
            }
            markAsFileSourced(connection, created)
            return created.toList()
        }

        val table = sanitizeTableName(tableNameHint ?: File(filePath).name)
        val reader = readerFor(filePath, format, encoding, sheet)
        try {
            connection.createStatement().use { st -> st.execute("CREATE VIEW ${quoteIdent(table)} AS SELECT * FROM $reader") }
        } catch (e: Exception) {
            throw AskSqlException(AskSqlErrorCode.FILE_LOAD_ERROR, userMessage = "Couldn't read \"${File(filePath).name}\": ${e.message}", detail = e.message, cause = e)
        }
        markAsFileSourced(connection, listOf(table))
        return listOf(table)
    }
}
