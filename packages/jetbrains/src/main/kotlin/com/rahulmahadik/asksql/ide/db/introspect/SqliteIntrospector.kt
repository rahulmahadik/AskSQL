package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import java.sql.Connection

/**
 * SQLite exposes no comment or row-estimate metadata; only foreign keys need SQLite's own `PRAGMA`
 * (see [loadForeignKeys]). What a column MEANS is not in its type either, and [ColumnHints] states that
 * for every engine; HintParityTest holds it to the same vectors as packages/sqlite/src/index.ts.
 */
object SqliteIntrospector : Introspector {

    override fun introspect(connection: Connection, nameKeys: Boolean): SchemaCatalog {
        val raw = CommonIntrospection.listTables(
            connection,
            catalog = null,
            schemaPattern = null,
            columnsOf = { table -> loadColumns(connection, table.name) },
        ).filterNot { it.name.startsWith("sqlite_") }

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
        // The hints themselves are shared with every other engine; see ColumnHints.
        return SchemaCatalog(engine = EngineKind.SQLITE, tables = ColumnHints.annotate(connection, EngineKind.SQLITE, tables, nameKeys))
    }

    /**
     * Columns come from `PRAGMA table_info`, one table at a time. sqlite-jdbc answers a whole-schema
     * `getColumns()` by unioning one SELECT per column, and SQLite rejects a compound SELECT past 500
     * terms; an ordinary Android schema carries more columns than that. Mirrors `packages/sqlite`.
     */
    private fun loadColumns(connection: Connection, table: String): List<ColumnInfo> {
        val quoted = "\"${table.replace("\"", "\"\"")}\""
        val columns = mutableListOf<ColumnInfo>()
        connection.createStatement().use { st ->
            st.executeQuery("PRAGMA table_info($quoted)").use { rs ->
                while (rs.next()) {
                    columns += ColumnInfo(
                        name = rs.getString("name"),
                        dbType = rs.getString("type")?.takeIf { it.isNotBlank() } ?: "TEXT",
                        nullable = rs.getInt("notnull") == 0,
                        default = rs.getString("dflt_value"),
                    )
                }
            }
        }
        return columns
    }

    /** SQLite's `getImportedKeys()` reports blank FK names and scrambles multi-column FK rows; `PRAGMA foreign_key_list` groups them by an explicit `id` column. */
    private fun loadForeignKeys(connection: Connection, table: String): List<ForeignKeyInfo>? {
        data class Row(val id: Int, val seq: Int, val refTable: String, val from: String, val to: String)
        val rows = mutableListOf<Row>()
        return try {
            // PRAGMA doesn't support bind parameters; the name is quoted as an identifier.
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
            null // fall back to the generic JDBC result
        }
    }
}
