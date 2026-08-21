package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.RoutineInfo
import com.rahulmahadik.asksql.ide.model.RoutineKind
import com.rahulmahadik.asksql.ide.model.RoutineVolatility
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import java.sql.Connection

/**
 * Oracle has no catalog concept; queries scope to `connection.schema` via `ALL_*` views, never `DBA_*`.
 * Routines report UNKNOWN volatility, which Oracle exposes no reliable signal for.
 */
object OracleIntrospector : Introspector {

    override fun introspect(connection: Connection, nameKeys: Boolean): SchemaCatalog {
        val currentSchema = connection.schema ?: connection.metaData.userName
        val batched = OracleConstraints.load(connection, currentSchema)
        val raw = CommonIntrospection.listTables(
            connection,
            catalog = null,
            schemaPattern = currentSchema,
            loadConstraints = batched == null,
            constraintsOf = batched?.let { { it } },
        )

        val tableComments = tableComments(connection, currentSchema)
        val columnComments = columnComments(connection, currentSchema)
        // NUM_ROWS is the last gathered statistic (DBMS_STATS or auto-stats), not a live count.
        val rowEstimates = rowEstimates(connection, currentSchema)

        val tables = raw.map { t ->
            TableInfo(
                schema = t.schema,
                name = t.name,
                kind = t.kind,
                columns = t.columns.map { c -> c.copy(comment = columnComments["${t.name}.${c.name}"]) },
                primaryKey = t.primaryKey,
                foreignKeys = t.foreignKeys,
                uniques = t.uniques,
                indexes = t.indexes,
                comment = tableComments[t.name],
                rowEstimate = rowEstimates[t.name],
            )
        }

        return SchemaCatalog(
            engine = EngineKind.ORACLE,
            schemas = listOfNotNull(currentSchema),
            // A column's type says nothing about an epoch unit or a JSON column's keys; see ColumnHints.
            tables = ColumnHints.annotate(connection, EngineKind.ORACLE, tables, nameKeys),
            routines = routines(connection, currentSchema),
            warnings = if (tables.isEmpty()) readableSchemaHint(connection, currentSchema) else emptyList(),
        )
    }

    /**
     * An account that only holds grants sees nothing in its own schema while its tables sit under
     * another owner. Naming those owners turns an empty tree into something the user can act on.
     */
    private fun readableSchemaHint(connection: Connection, schema: String?): List<String> = runCatching {
        val owners = mutableListOf<String>()
        connection.prepareStatement(
            "SELECT owner, COUNT(*) AS n FROM all_tables WHERE owner <> ? AND owner NOT IN " +
                "('SYS','SYSTEM','XDB','MDSYS','CTXSYS','OUTLN','DBSNMP','APPQOSSYS','AUDSYS','GSMADMIN_INTERNAL'," +
                "'OJVMSYS','ORDSYS','ORDDATA','OLAPSYS','LBACSYS','WMSYS','DVSYS','RDSADMIN') " +
                "GROUP BY owner ORDER BY COUNT(*) DESC FETCH FIRST 5 ROWS ONLY",
        ).use { ps ->
            ps.setString(1, schema ?: "")
            ps.executeQuery().use { rs ->
                while (rs.next()) owners.add("${rs.getString("owner")} (${rs.getInt("n")} tables)")
            }
        }
        if (owners.isEmpty()) emptyList()
        else listOf("No tables are visible in ${schema ?: "this schema"}. Readable schemas: ${owners.joinToString(", ")}.")
    }.getOrDefault(emptyList())

    private fun tableComments(connection: Connection, schema: String?): Map<String, String> {
        val map = mutableMapOf<String, String>()
        connection.prepareStatement(
            "SELECT TABLE_NAME, COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = ? AND COMMENTS IS NOT NULL",
        ).use { ps ->
            ps.setString(1, schema)
            ps.executeQuery().use { rs ->
                while (rs.next()) map[rs.getString("TABLE_NAME")] = rs.getString("COMMENTS")
            }
        }
        return map
    }

    private fun columnComments(connection: Connection, schema: String?): Map<String, String> {
        val map = mutableMapOf<String, String>()
        connection.prepareStatement(
            "SELECT TABLE_NAME, COLUMN_NAME, COMMENTS FROM ALL_COL_COMMENTS WHERE OWNER = ? AND COMMENTS IS NOT NULL",
        ).use { ps ->
            ps.setString(1, schema)
            ps.executeQuery().use { rs ->
                while (rs.next()) map["${rs.getString("TABLE_NAME")}.${rs.getString("COLUMN_NAME")}"] = rs.getString("COMMENTS")
            }
        }
        return map
    }

    private fun rowEstimates(connection: Connection, schema: String?): Map<String, Long> {
        val map = mutableMapOf<String, Long>()
        connection.prepareStatement(
            "SELECT TABLE_NAME, NUM_ROWS FROM ALL_TABLES WHERE OWNER = ? AND NUM_ROWS IS NOT NULL",
        ).use { ps ->
            ps.setString(1, schema)
            ps.executeQuery().use { rs ->
                while (rs.next()) map[rs.getString("TABLE_NAME")] = rs.getLong("NUM_ROWS")
            }
        }
        return map
    }

    /** Standalone functions/procedures only; package member subprograms are not listed. */
    private fun routines(connection: Connection, schema: String?): List<RoutineInfo> {
        val list = mutableListOf<RoutineInfo>()
        connection.prepareStatement(
            "SELECT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = ? AND OBJECT_TYPE IN ('FUNCTION', 'PROCEDURE') AND STATUS = 'VALID'",
        ).use { ps ->
            ps.setString(1, schema)
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    list += RoutineInfo(
                        schema = schema,
                        name = rs.getString("OBJECT_NAME"),
                        kind = if (rs.getString("OBJECT_TYPE") == "PROCEDURE") RoutineKind.PROCEDURE else RoutineKind.FUNCTION,
                        args = "",
                        returns = null,
                        volatility = RoutineVolatility.UNKNOWN,
                    )
                }
            }
        }
        return list
    }
}
