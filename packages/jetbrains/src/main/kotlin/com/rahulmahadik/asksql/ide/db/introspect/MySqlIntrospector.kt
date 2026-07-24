package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.RoutineInfo
import com.rahulmahadik.asksql.ide.model.RoutineKind
import com.rahulmahadik.asksql.ide.model.RoutineVolatility
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import java.sql.Connection

object MySqlIntrospector : Introspector {

    private val ENUM_COLUMN_TYPE = Regex("""^enum\((.*)\)$""", RegexOption.IGNORE_CASE)

    override fun introspect(connection: Connection): SchemaCatalog {
        val currentSchema = connection.catalog
        val raw = CommonIntrospection.listTables(connection, catalog = currentSchema, schemaPattern = null)

        val tableComments = mutableMapOf<String, String>()
        val columnComments = mutableMapOf<String, String>()
        val rowEstimates = mutableMapOf<String, Long>()
        // COLUMN_TYPE carries the full declared type, e.g. "enum('a','b','c')"; the JDBC
        // TYPE_NAME-equivalent exposes only the bare "enum", so literal values must come from here.
        val columnTypes = mutableMapOf<String, String>()

        connection.createStatement().use { st ->
            st.executeQuery(
                """
                SELECT TABLE_NAME, TABLE_COMMENT, TABLE_ROWS
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = '${currentSchema.orEmpty().replace("'", "''")}'
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    val name = rs.getString("TABLE_NAME")
                    rs.getString("TABLE_COMMENT")?.takeIf { it.isNotEmpty() }?.let { tableComments[name] = it }
                    val estimate = rs.getLong("TABLE_ROWS")
                    if (!rs.wasNull()) rowEstimates[name] = estimate
                }
            }
            st.executeQuery(
                """
                SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT, COLUMN_TYPE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = '${currentSchema.orEmpty().replace("'", "''")}'
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    val key = "${rs.getString("TABLE_NAME")}.${rs.getString("COLUMN_NAME")}"
                    val comment = rs.getString("COLUMN_COMMENT")
                    if (!comment.isNullOrEmpty()) columnComments[key] = comment
                    rs.getString("COLUMN_TYPE")?.let { columnTypes[key] = it }
                }
            }
        }

        val tables = raw.map { t ->
            TableInfo(
                schema = t.schema,
                name = t.name,
                kind = t.kind,
                columns = t.columns.map { c ->
                    val key = "${t.name}.${c.name}"
                    c.copy(comment = columnComments[key], enumValues = enumValuesOf(columnTypes[key]))
                },
                primaryKey = t.primaryKey,
                foreignKeys = t.foreignKeys,
                uniques = t.uniques,
                indexes = t.indexes,
                comment = tableComments[t.name],
                rowEstimate = rowEstimates[t.name],
            )
        }

        return SchemaCatalog(
            engine = EngineKind.MYSQL,
            schemas = listOfNotNull(currentSchema),
            tables = tables,
            routines = routines(connection, currentSchema),
        )
    }

    /** Parses `enum('a','b','c')` into `[a, b, c]`; a direct port of the reference `@asksql/mysql` connector's regex (does not handle a comma embedded inside a quoted label, matching that connector's own known limitation). */
    private fun enumValuesOf(columnType: String?): List<String> {
        if (columnType == null) return emptyList()
        val match = ENUM_COLUMN_TYPE.find(columnType) ?: return emptyList()
        return match.groupValues[1].split(',').map {
            it.trim().removeSurrounding("'").replace("''", "'")
        }
    }

    /** Functions/procedures; powers the prompt's "CALLABLE READ-ONLY FUNCTIONS" section. MySQL exposes no PG-style volatility, so a deterministic routine is treated as STABLE (callable) and everything else as UNKNOWN (listed, never called), matching the reference connector's rule exactly. */
    private fun routines(connection: Connection, schema: String?): List<RoutineInfo> {
        val list = mutableListOf<RoutineInfo>()
        connection.createStatement().use { st ->
            st.executeQuery(
                """
                SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, IS_DETERMINISTIC
                FROM information_schema.ROUTINES
                WHERE ROUTINE_SCHEMA = '${schema.orEmpty().replace("'", "''")}'
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    list += RoutineInfo(
                        schema = schema,
                        name = rs.getString("ROUTINE_NAME"),
                        kind = if ("PROCEDURE".equals(rs.getString("ROUTINE_TYPE"), ignoreCase = true)) RoutineKind.PROCEDURE else RoutineKind.FUNCTION,
                        args = "",
                        returns = rs.getString("DTD_IDENTIFIER"),
                        volatility = if ("YES".equals(rs.getString("IS_DETERMINISTIC"), ignoreCase = true)) RoutineVolatility.STABLE else RoutineVolatility.UNKNOWN,
                    )
                }
            }
        }
        return list
    }
}
