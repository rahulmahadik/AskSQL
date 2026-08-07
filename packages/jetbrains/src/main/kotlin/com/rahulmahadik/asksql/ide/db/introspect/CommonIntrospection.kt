package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.IndexInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import java.sql.Connection
import java.sql.DatabaseMetaData

/**
 * Portable [DatabaseMetaData]-based base layer (tables, columns, PKs, FKs, indexes); each engine's
 * introspector layers its own SQL on top for what JDBC metadata doesn't expose well (comments, enums, row estimates).
 */
object CommonIntrospection {

    /** `DatabaseMetaData` name arguments are LIKE patterns: an unescaped `_` matches an unrelated sibling (`foo_bar` matching `fooxbar`). */
    private fun DatabaseMetaData.escapePattern(literal: String): String {
        val esc = try { searchStringEscape } catch (e: Exception) { "\\" }
        return literal.replace(esc, esc + esc).replace("_", "${esc}_").replace("%", "${esc}%")
    }

    data class RawTable(
        val schema: String?,
        val name: String,
        val kind: TableKind,
        val columns: MutableList<ColumnInfo> = mutableListOf(),
        var primaryKey: List<String> = emptyList(),
        var foreignKeys: List<ForeignKeyInfo> = emptyList(),
        var uniques: List<List<String>> = emptyList(),
        var indexes: List<IndexInfo> = emptyList(),
    )

    /** @param schemaPattern an EXACT schema name, escaped internally despite the pattern-shaped JDBC parameter; null means every schema. */
    fun listTables(
        connection: Connection,
        catalog: String?,
        schemaPattern: String?,
        /** False when the caller loads keys and indexes itself in one pass instead of three per table. */
        loadConstraints: Boolean = true,
    ): List<RawTable> {
        val meta = connection.metaData
        val result = mutableListOf<RawTable>()
        val escapedSchemaPattern = schemaPattern?.let { meta.escapePattern(it) }
        // "PARTITIONED TABLE" is pgjdbc's own TABLE_TYPE for a declaratively partitioned table's PARENT row; without it only its children appear, as ordinary "TABLE".
        meta.getTables(catalog, escapedSchemaPattern, "%", arrayOf("TABLE", "VIEW", "MATERIALIZED VIEW", "SYSTEM TABLE", "PARTITIONED TABLE")).use { rs ->
            while (rs.next()) {
                val tableType = rs.getString("TABLE_TYPE")
                if (tableType == "SYSTEM TABLE") continue
                val kind = when (tableType) {
                    "VIEW" -> TableKind.VIEW
                    "MATERIALIZED VIEW" -> TableKind.MATERIALIZED_VIEW
                    else -> TableKind.TABLE
                }
                result += RawTable(
                    schema = rs.getString("TABLE_SCHEM"),
                    name = rs.getString("TABLE_NAME"),
                    kind = kind,
                )
            }
        }
        // One getColumns() call for the whole schema: its tableNamePattern is a portable JDBC wildcard, unlike the `table` parameter of the per-table calls below.
        val columnsByTable = loadAllColumns(meta, catalog, escapedSchemaPattern)
        for (table in result) {
            table.columns.addAll(columnsByTable[table.schema to table.name].orEmpty())
            if (loadConstraints) {
                table.primaryKey = loadPrimaryKey(meta, catalog, table.schema, table.name)
                table.foreignKeys = loadForeignKeys(meta, catalog, table.schema, table.name)
                table.indexes = loadIndexes(meta, catalog, table.schema, table.name)
            }
        }
        return result
    }

    /** Keyed by the EXACT (schema, table) pair from each result row, not by pattern matching. */
    private fun loadAllColumns(meta: DatabaseMetaData, catalog: String?, schemaPattern: String?): Map<Pair<String?, String>, List<ColumnInfo>> {
        val byTable = linkedMapOf<Pair<String?, String>, MutableList<ColumnInfo>>()
        meta.getColumns(catalog, schemaPattern, "%", "%").use { rs ->
            while (rs.next()) {
                val key = rs.getString("TABLE_SCHEM") to rs.getString("TABLE_NAME")
                byTable.getOrPut(key) { mutableListOf() } += ColumnInfo(
                    name = rs.getString("COLUMN_NAME"),
                    dbType = rs.getString("TYPE_NAME") ?: "unknown",
                    nullable = rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                    default = rs.getString("COLUMN_DEF"),
                    generated = (rs.getString("IS_GENERATEDCOLUMN") ?: "NO").equals("YES", ignoreCase = true),
                )
            }
        }
        return byTable
    }

    private fun loadPrimaryKey(meta: DatabaseMetaData, catalog: String?, schema: String?, table: String): List<String> {
        val ordered = sortedMapOf<Short, String>()
        meta.getPrimaryKeys(catalog, schema, table).use { rs ->
            while (rs.next()) {
                ordered[rs.getShort("KEY_SEQ")] = rs.getString("COLUMN_NAME")
            }
        }
        return ordered.values.toList()
    }

    private fun loadForeignKeys(meta: DatabaseMetaData, catalog: String?, schema: String?, table: String): List<ForeignKeyInfo> {
        data class Row(val fkName: String?, val column: String, val refSchema: String?, val refTable: String, val refColumn: String, val seq: Short)
        val rows = mutableListOf<Row>()
        meta.getImportedKeys(catalog, schema, table).use { rs ->
            while (rs.next()) {
                rows += Row(
                    fkName = rs.getString("FK_NAME"),
                    column = rs.getString("FKCOLUMN_NAME"),
                    refSchema = rs.getString("PKTABLE_SCHEM"),
                    refTable = rs.getString("PKTABLE_NAME"),
                    refColumn = rs.getString("PKCOLUMN_NAME"),
                    seq = rs.getShort("KEY_SEQ"),
                )
            }
        }
        return rows.groupBy { it.fkName to it.refTable }.map { (key, group) ->
            val ordered = group.sortedBy { it.seq }
            ForeignKeyInfo(
                name = key.first,
                columns = ordered.map { it.column },
                refSchema = ordered.first().refSchema,
                refTable = ordered.first().refTable,
                refColumns = ordered.map { it.refColumn },
            )
        }
    }

    private fun loadIndexes(meta: DatabaseMetaData, catalog: String?, schema: String?, table: String): List<IndexInfo> {
        data class Row(val name: String, val unique: Boolean, val column: String, val pos: Short)
        val rows = mutableListOf<Row>()
        try {
            meta.getIndexInfo(catalog, schema, table, false, true).use { rs ->
                while (rs.next()) {
                    val name = rs.getString("INDEX_NAME") ?: continue
                    val column = rs.getString("COLUMN_NAME") ?: continue
                    rows += Row(name, !rs.getBoolean("NON_UNIQUE"), column, rs.getShort("ORDINAL_POSITION"))
                }
            }
        } catch (e: Exception) {
            return emptyList() // some engines/driver combos throw on exotic index types; indexes are informational only
        }
        return rows.groupBy { it.name }.map { (name, group) ->
            val ordered = group.sortedBy { it.pos }
            IndexInfo(name = name, columns = ordered.map { it.column }, unique = ordered.first().unique)
        }
    }
}
