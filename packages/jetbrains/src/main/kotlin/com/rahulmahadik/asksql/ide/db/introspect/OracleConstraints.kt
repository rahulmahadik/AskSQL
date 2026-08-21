package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.IndexInfo
import java.sql.Connection

/**
 * Primary keys, foreign keys and indexes for a whole schema in three queries. Ported from
 * `packages/oracle/src/introspect.ts`'s `ALL_CONSTRAINTS`/`ALL_CONS_COLUMNS`/`ALL_INDEXES` queries,
 * which the generic JDBC path does the same job as - `getPrimaryKeys`/`getImportedKeys`/`getIndexInfo`
 * all take an exact table name rather than a pattern, so that path costs three round trips per table.
 * Verified live (see OracleConstraintsShapesTest): matched the generic path exactly, at 3.6s vs 106s
 * on a 65-table schema.
 *
 * `ALL_CONS_COLUMNS` also returns rows for recycle-bin ("BIN$...") tables left by a `DROP TABLE`
 * without `PURGE`. Harmless - that name can never match a real table - but inflates a raw count of
 * this map taken without going through the caller that looks entries up by real table name.
 */
object OracleConstraints {

    private const val PK_SQL = """
        SELECT cc.table_name, cc.column_name, cc.position
        FROM all_constraints c
        JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
        WHERE c.owner = ? AND c.constraint_type = 'P'
        ORDER BY cc.table_name, cc.position
    """

    private const val FK_SQL = """
        SELECT c.constraint_name AS fk_name, cc.table_name, cc.column_name, cc.position,
               rc.owner AS ref_owner, rc.table_name AS ref_table, rcc.column_name AS ref_column
        FROM all_constraints c
        JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
        JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
        JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
                                 AND rcc.position = cc.position
        WHERE c.owner = ? AND c.constraint_type = 'R'
        ORDER BY c.constraint_name, cc.position
    """

    private const val INDEX_SQL = """
        SELECT i.index_name, i.table_name, i.uniqueness, ic.column_name, ic.column_position
        FROM all_indexes i
        JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
        WHERE i.owner = ?
        ORDER BY i.table_name, i.index_name, ic.column_position
    """

    /** Null on ANY failure, so the generic per-table path (slower, never wrong) is always the fallback. */
    fun load(connection: Connection, owner: String): Map<Pair<String?, String>, CommonIntrospection.Constraints>? = try {
        val primaryKey = linkedMapOf<String, MutableList<String>>()
        connection.prepareStatement(PK_SQL).use { ps ->
            ps.setString(1, owner)
            ps.executeQuery().use { rs ->
                while (rs.next()) primaryKey.getOrPut(rs.getString("table_name")) { mutableListOf() } += rs.getString("column_name")
            }
        }

        data class FkGroup(val table: String, val cols: MutableList<String>, var refTable: String? = null, val refCols: MutableList<String>)
        val fkGroups = linkedMapOf<String, FkGroup>()
        connection.prepareStatement(FK_SQL).use { ps ->
            ps.setString(1, owner)
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    val key = "${rs.getString("table_name")}.${rs.getString("fk_name")}"
                    val g = fkGroups.getOrPut(key) { FkGroup(rs.getString("table_name"), mutableListOf(), refCols = mutableListOf()) }
                    g.cols += rs.getString("column_name")
                    g.refTable = rs.getString("ref_table")
                    g.refCols += rs.getString("ref_column")
                }
            }
        }
        val foreignKeys = linkedMapOf<String, MutableList<ForeignKeyInfo>>()
        for (g in fkGroups.values) {
            val refTable = g.refTable ?: continue
            foreignKeys.getOrPut(g.table) { mutableListOf() } += ForeignKeyInfo(columns = g.cols, refTable = refTable, refColumns = g.refCols)
        }

        data class IdxBuild(val name: String, val cols: MutableList<String>, val unique: Boolean)
        val idxByTable = linkedMapOf<String, LinkedHashMap<String, IdxBuild>>()
        connection.prepareStatement(INDEX_SQL).use { ps ->
            ps.setString(1, owner)
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    val table = rs.getString("table_name")
                    val idxName = rs.getString("index_name")
                    val m = idxByTable.getOrPut(table) { linkedMapOf() }
                    val entry = m.getOrPut(idxName) {
                        IdxBuild(idxName, mutableListOf(), rs.getString("uniqueness") == "UNIQUE")
                    }
                    entry.cols += rs.getString("column_name")
                }
            }
        }
        val indexes = idxByTable.mapValues { (_, m) -> m.values.map { IndexInfo(name = it.name, columns = it.cols, unique = it.unique) } }

        buildMap {
            val tables = primaryKey.keys + foreignKeys.keys + indexes.keys
            for (t in tables) {
                put(
                    owner to t,
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
