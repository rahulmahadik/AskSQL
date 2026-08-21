package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.IndexInfo
import java.sql.Connection

/**
 * Primary keys, foreign keys and indexes for a whole schema in two queries. Ported from
 * `packages/mysql/src/introspect.ts`'s `KEY_COLUMN_USAGE`/`STATISTICS` grouping, which the generic
 * JDBC path does the same job as - `getPrimaryKeys`/`getImportedKeys`/`getIndexInfo` all take an exact
 * table name rather than a pattern, so that path costs three round trips per table.
 */
object MysqlConstraints {

    private const val KEY_COLS_SQL =
        "SELECT TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION " +
            "FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION"

    private const val STATS_SQL =
        "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE " +
            "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"

    /** Null on ANY failure, so the generic per-table path (slower, never wrong) is always the fallback. */
    fun load(connection: Connection, database: String): Map<Pair<String?, String>, CommonIntrospection.Constraints>? = try {
        val primaryKey = linkedMapOf<String, MutableList<String>>()
        data class FkGroup(val table: String, val cols: MutableList<String>, val refTable: String, val refCols: MutableList<String>)
        val fkGroups = linkedMapOf<String, FkGroup>()

        connection.prepareStatement(KEY_COLS_SQL).use { ps ->
            ps.setString(1, database)
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    val table = rs.getString("TABLE_NAME")
                    val constraint = rs.getString("CONSTRAINT_NAME")
                    val col = rs.getString("COLUMN_NAME")
                    if (constraint == "PRIMARY") {
                        primaryKey.getOrPut(table) { mutableListOf() } += col
                    } else {
                        val refTable = rs.getString("REFERENCED_TABLE_NAME") ?: continue
                        val key = "$table.$constraint"
                        val g = fkGroups.getOrPut(key) { FkGroup(table, mutableListOf(), refTable, mutableListOf()) }
                        g.cols += col
                        g.refCols += rs.getString("REFERENCED_COLUMN_NAME")
                    }
                }
            }
        }
        val foreignKeys = linkedMapOf<String, MutableList<ForeignKeyInfo>>()
        for (g in fkGroups.values) {
            foreignKeys.getOrPut(g.table) { mutableListOf() } += ForeignKeyInfo(columns = g.cols, refTable = g.refTable, refColumns = g.refCols)
        }

        data class IdxBuild(val name: String, val cols: MutableList<String>, val unique: Boolean, val method: String)
        val idxByTable = linkedMapOf<String, LinkedHashMap<String, IdxBuild>>()
        connection.prepareStatement(STATS_SQL).use { ps ->
            ps.setString(1, database)
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    val table = rs.getString("TABLE_NAME")
                    val idxName = rs.getString("INDEX_NAME")
                    val m = idxByTable.getOrPut(table) { linkedMapOf() }
                    val entry = m.getOrPut(idxName) {
                        IdxBuild(idxName, mutableListOf(), rs.getInt("NON_UNIQUE") == 0, rs.getString("INDEX_TYPE") ?: "")
                    }
                    entry.cols += rs.getString("COLUMN_NAME")
                }
            }
        }
        val indexes = idxByTable.mapValues { (_, m) ->
            m.values.map { IndexInfo(name = it.name, columns = it.cols, unique = it.unique, method = it.method.ifBlank { null }) }
        }

        buildMap {
            val tables = primaryKey.keys + foreignKeys.keys + indexes.keys
            for (t in tables) {
                put(
                    null to t,
                    CommonIntrospection.Constraints(
                        primaryKey = primaryKey[t].orEmpty(),
                        foreignKeys = foreignKeys[t].orEmpty(),
                        indexes = indexes[t].orEmpty(),
                    ),
                )
            }
        }
    } catch (e: Exception) {
        null
    }
}
