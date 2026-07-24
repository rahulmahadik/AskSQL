package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import java.sql.Connection

/** SQLite has no comment/row-estimate metadata surface, so the common [DatabaseMetaData] extraction is the whole story, except foreign keys, which need SQLite's own `PRAGMA` (see [loadForeignKeys]). */
object SqliteIntrospector : Introspector {

    override fun introspect(connection: Connection): SchemaCatalog {
        val raw = CommonIntrospection.listTables(connection, catalog = null, schemaPattern = null)
            .filterNot { it.name.startsWith("sqlite_") }

        val tables = raw.map { t ->
            TableInfo(
                schema = t.schema,
                name = t.name,
                kind = t.kind,
                columns = t.columns,
                primaryKey = t.primaryKey,
                foreignKeys = loadForeignKeys(connection, t.name) ?: t.foreignKeys,
                uniques = t.uniques,
                indexes = t.indexes,
            )
        }
        return SchemaCatalog(engine = EngineKind.SQLITE, tables = tables)
    }

    /**
     * SQLite's `getImportedKeys()` reports blank FK names and scrambles multi-column FK rows;
     * `PRAGMA foreign_key_list` groups correctly via an explicit `id` column, so it replaces the generic path.
     */
    private fun loadForeignKeys(connection: Connection, table: String): List<ForeignKeyInfo>? {
        data class Row(val id: Int, val seq: Int, val refTable: String, val from: String, val to: String)
        val rows = mutableListOf<Row>()
        return try {
            // PRAGMA doesn't support bind parameters; the name is quoted as
            // an identifier (embedded quotes doubled), not interpolated as a string literal.
            val quoted = "\"${table.replace("\"", "\"\"")}\""
            connection.createStatement().use { st ->
                st.executeQuery("PRAGMA foreign_key_list($quoted)").use { rs ->
                    while (rs.next()) {
                        rows += Row(
                            id = rs.getInt("id"),
                            seq = rs.getInt("seq"),
                            refTable = rs.getString("table"),
                            from = rs.getString("from"),
                            to = rs.getString("to"),
                        )
                    }
                }
            }
            rows.groupBy { it.id }.map { (_, group) ->
                val ordered = group.sortedBy { it.seq }
                ForeignKeyInfo(
                    columns = ordered.map { it.from },
                    refTable = ordered.first().refTable,
                    refColumns = ordered.map { it.to },
                )
            }
        } catch (e: Exception) {
            null // fall back to the (less precise) generic JDBC result rather than losing FK info entirely
        }
    }
}
