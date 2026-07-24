package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.RoutineInfo
import com.rahulmahadik.asksql.ide.model.RoutineKind
import com.rahulmahadik.asksql.ide.model.RoutineVolatility
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import java.sql.Connection

/**
 * Oracle has no catalog concept, so queries scope to `connection.schema` via `ALL_*` views, never `DBA_*`
 * (privilege this plugin shouldn't need). Routine volatility has no reliable signal, so routines report UNKNOWN: listed, never offered as callable.
 */
object OracleIntrospector : Introspector {

    override fun introspect(connection: Connection): SchemaCatalog {
        val currentSchema = connection.schema ?: connection.metaData.userName
        val raw = CommonIntrospection.listTables(connection, catalog = null, schemaPattern = currentSchema)

        val tableComments = tableComments(connection, currentSchema)
        val columnComments = columnComments(connection, currentSchema)
        // NUM_ROWS reflects the last time statistics were gathered (DBMS_STATS or an auto-stats
        // job), not a live count, the same estimate-not-exact contract Postgres's reltuples
        // already carries in PostgresIntrospector.
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
            tables = tables,
            routines = routines(connection, currentSchema),
        )
    }

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

    /** Standalone functions/procedures only (v1); package member subprograms need `ALL_PROCEDURES`/`ALL_ARGUMENTS` join work not yet done here. */
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
