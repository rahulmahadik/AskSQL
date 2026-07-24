package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.db.DuckDbFileLoader
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableSource
import java.sql.Connection

object DuckDbIntrospector : Introspector {

    override fun introspect(connection: Connection): SchemaCatalog {
        val raw = CommonIntrospection.listTables(connection, catalog = null, schemaPattern = null)
            .filterNot { it.schema in setOf("information_schema", "pg_catalog") }
            .filterNot { it.name == DuckDbFileLoader.UPLOAD_MARKER_TABLE }

        val fileSourced = fileSourcedTableNames(connection)

        val comments = mutableMapOf<String, String>()
        val rowEstimates = mutableMapOf<String, Long>()
        try {
            connection.createStatement().use { st ->
                st.executeQuery(
                    "SELECT schema_name, table_name, comment, estimated_size FROM duckdb_tables()",
                ).use { rs ->
                    while (rs.next()) {
                        val key = "${rs.getString("schema_name")}.${rs.getString("table_name")}"
                        rs.getString("comment")?.takeIf { it.isNotEmpty() }?.let { comments[key] = it }
                        val estimate = rs.getLong("estimated_size")
                        if (!rs.wasNull() && estimate >= 0) rowEstimates[key] = estimate
                    }
                }
            }
        } catch (e: Exception) {
            // duckdb_tables() unavailable on very old DuckDB builds; comments/estimates are enhancements only.
        }

        val tables = raw.map { t ->
            val key = "${t.schema}.${t.name}"
            TableInfo(
                schema = t.schema,
                name = t.name,
                kind = t.kind,
                columns = t.columns,
                primaryKey = t.primaryKey,
                foreignKeys = t.foreignKeys,
                uniques = t.uniques,
                indexes = t.indexes,
                comment = comments[key],
                rowEstimate = rowEstimates[key],
                source = if (t.name in fileSourced) TableSource.FILE else TableSource.DB,
            )
        }
        val schemas = raw.mapNotNull { it.schema }.distinct()
        return SchemaCatalog(engine = EngineKind.DUCKDB, schemas = schemas, tables = tables)
    }

    /** [DuckDbFileLoader] records every table/view it loads from a user file in its own marker table; absent entirely for a DuckDB database that was never used with the upload feature. */
    private fun fileSourcedTableNames(connection: Connection): Set<String> {
        val names = mutableSetOf<String>()
        try {
            connection.createStatement().use { st ->
                st.executeQuery("SELECT table_name FROM \"${DuckDbFileLoader.UPLOAD_MARKER_TABLE}\"").use { rs ->
                    while (rs.next()) names += rs.getString("table_name")
                }
            }
        } catch (e: Exception) {
            // Marker table doesn't exist: this DuckDB database was never used with the file-upload feature.
        }
        return names
    }
}
