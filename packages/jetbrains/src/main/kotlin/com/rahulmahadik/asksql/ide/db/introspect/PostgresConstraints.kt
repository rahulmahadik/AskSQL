package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.ForeignKeyInfo
import com.rahulmahadik.asksql.ide.model.IndexInfo
import java.sql.Connection

/**
 * Primary keys, foreign keys and indexes for a whole database in three queries.
 *
 * JDBC's `getPrimaryKeys`, `getImportedKeys` and `getIndexInfo` take a table name rather than a
 * pattern, so the portable path costs three round trips per table: on a 300-table schema that is
 * roughly 900, which a remote database charges its full latency for.
 */
object PostgresConstraints {

    data class Loaded(
        val primaryKeys: Map<Pair<String?, String>, List<String>>,
        val foreignKeys: Map<Pair<String?, String>, List<ForeignKeyInfo>>,
        val indexes: Map<Pair<String?, String>, List<IndexInfo>>,
    )

    private const val PK_SQL = """
        SELECT n.nspname AS s, c.relname AS t, a.attname AS col, k.ord
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indisprimary AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, c.relname, k.ord
    """

    private const val FK_SQL = """
        SELECT con.conname AS name, n.nspname AS s, c.relname AS t, a.attname AS col,
               fn.nspname AS ref_s, fc.relname AS ref_t, fa.attname AS ref_col, k.ord
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class fc ON fc.oid = con.confrelid
        JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
        JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = fk.attnum
        WHERE con.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, c.relname, con.conname, k.ord
    """

    private const val INDEX_SQL = """
        SELECT n.nspname AS s, c.relname AS t, ic.relname AS name, i.indisunique AS uniq,
               COALESCE(a.attname, pg_get_indexdef(i.indexrelid, k.ord::int, true)) AS col, k.ord
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, c.relname, ic.relname, k.ord
    """

    /** Null when the catalogs cannot be read, so the caller keeps the per-table JDBC path. */
    fun load(connection: Connection): Loaded? = runCatching {
        Loaded(primaryKeys = loadPks(connection), foreignKeys = loadFks(connection), indexes = loadIndexes(connection))
    }.getOrNull()

    private fun loadPks(connection: Connection): Map<Pair<String?, String>, List<String>> {
        val out = linkedMapOf<Pair<String?, String>, MutableList<String>>()
        connection.createStatement().use { st ->
            st.executeQuery(PK_SQL).use { rs ->
                while (rs.next()) {
                    out.getOrPut(rs.getString("s") to rs.getString("t")) { mutableListOf() }.add(rs.getString("col"))
                }
            }
        }
        return out
    }

    private fun loadFks(connection: Connection): Map<Pair<String?, String>, List<ForeignKeyInfo>> {
        data class Row(val name: String, val col: String, val refS: String?, val refT: String, val refCol: String)
        val byTable = linkedMapOf<Pair<String?, String>, MutableList<Row>>()
        connection.createStatement().use { st ->
            st.executeQuery(FK_SQL).use { rs ->
                while (rs.next()) {
                    byTable.getOrPut(rs.getString("s") to rs.getString("t")) { mutableListOf() }.add(
                        Row(rs.getString("name"), rs.getString("col"), rs.getString("ref_s"), rs.getString("ref_t"), rs.getString("ref_col")),
                    )
                }
            }
        }
        return byTable.mapValues { (_, rows) ->
            rows.groupBy { it.name to it.refT }.map { (key, group) ->
                ForeignKeyInfo(
                    name = key.first,
                    columns = group.map { it.col },
                    refSchema = group.first().refS,
                    refTable = group.first().refT,
                    refColumns = group.map { it.refCol },
                )
            }
        }
    }

    private fun loadIndexes(connection: Connection): Map<Pair<String?, String>, List<IndexInfo>> {
        data class Row(val name: String, val uniq: Boolean, val col: String)
        val byTable = linkedMapOf<Pair<String?, String>, MutableList<Row>>()
        connection.createStatement().use { st ->
            st.executeQuery(INDEX_SQL).use { rs ->
                while (rs.next()) {
                    byTable.getOrPut(rs.getString("s") to rs.getString("t")) { mutableListOf() }.add(
                        Row(rs.getString("name"), rs.getBoolean("uniq"), rs.getString("col")),
                    )
                }
            }
        }
        return byTable.mapValues { (_, rows) ->
            rows.groupBy { it.name }.map { (name, group) ->
                IndexInfo(name = name, unique = group.first().uniq, columns = group.map { it.col })
            }
        }
    }
}
