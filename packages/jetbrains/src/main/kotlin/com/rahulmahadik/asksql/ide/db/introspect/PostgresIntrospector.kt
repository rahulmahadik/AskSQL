package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.EnumTypeInfo
import com.rahulmahadik.asksql.ide.model.RoutineInfo
import com.rahulmahadik.asksql.ide.model.RoutineKind
import com.rahulmahadik.asksql.ide.model.RoutineVolatility
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import java.sql.Connection

object PostgresIntrospector : Introspector {

    override fun introspect(connection: Connection): SchemaCatalog {
        val raw = CommonIntrospection.listTables(connection, catalog = null, schemaPattern = null)
            .filterNot { it.schema in setOf("pg_catalog", "information_schema") }

        val comments = tableComments(connection)
        val columnComments = columnComments(connection)
        val rowEstimates = rowEstimates(connection)
        val partitions = partitionMeta(connection)
        val (enums, enumValuesByTypeName) = enumTypes(connection)

        val tables = raw.map { t ->
            val partition = partitions["${t.schema}.${t.name}"]
            TableInfo(
                schema = t.schema,
                name = t.name,
                kind = t.kind,
                columns = t.columns.map { c ->
                    c.copy(
                        comment = columnComments["${t.schema}.${t.name}.${c.name}"],
                        // pgjdbc reports a user-defined enum column's TYPE_NAME as the enum type's
                        // own (bare) name, e.g. "mood": the same lookup key the reference
                        // `@asksql/postgres` connector uses.
                        enumValues = enumValuesByTypeName[c.dbType] ?: emptyList(),
                    )
                },
                primaryKey = t.primaryKey,
                foreignKeys = t.foreignKeys,
                uniques = t.uniques,
                indexes = t.indexes,
                comment = comments["${t.schema}.${t.name}"],
                rowEstimate = rowEstimates["${t.schema}.${t.name}"],
                isPartitioned = partition?.isPartitioned ?: false,
                partitionOf = partition?.partitionOf,
            )
        }

        val schemas = raw.mapNotNull { it.schema }.distinct()

        return SchemaCatalog(
            engine = EngineKind.POSTGRES,
            schemas = schemas,
            tables = tables,
            enums = enums,
            routines = routines(connection),
        )
    }

    private fun tableComments(connection: Connection): Map<String, String> {
        val map = mutableMapOf<String, String>()
        connection.createStatement().use { st ->
            st.executeQuery(
                """
                SELECT n.nspname AS schema, c.relname AS name, obj_description(c.oid) AS comment
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r','v','m') AND obj_description(c.oid) IS NOT NULL
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    map["${rs.getString("schema")}.${rs.getString("name")}"] = rs.getString("comment")
                }
            }
        }
        return map
    }

    private fun columnComments(connection: Connection): Map<String, String> {
        val map = mutableMapOf<String, String>()
        connection.createStatement().use { st ->
            st.executeQuery(
                """
                SELECT n.nspname AS schema, c.relname AS table_name, a.attname AS column_name, d.description AS comment
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    map["${rs.getString("schema")}.${rs.getString("table_name")}.${rs.getString("column_name")}"] = rs.getString("comment")
                }
            }
        }
        return map
    }

    private fun rowEstimates(connection: Connection): Map<String, Long> {
        val map = mutableMapOf<String, Long>()
        connection.createStatement().use { st ->
            st.executeQuery(
                """
                SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS estimate
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'r' AND c.reltuples >= 0
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    map["${rs.getString("schema")}.${rs.getString("name")}"] = rs.getLong("estimate")
                }
            }
        }
        return map
    }

    /** Schema-qualified [EnumTypeInfo] list, plus a bare-type-name lookup for tagging column [ColumnInfo.enumValues]; matches the reference connector's `enumValuesByType` map exactly. */
    private fun enumTypes(connection: Connection): Pair<List<EnumTypeInfo>, Map<String, List<String>>> {
        val byType = linkedMapOf<Pair<String?, String>, MutableList<String>>()
        connection.createStatement().use { st ->
            st.executeQuery(
                """
                SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS value
                FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                JOIN pg_namespace n ON n.oid = t.typnamespace
                ORDER BY t.typname, e.enumsortorder
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    val key = rs.getString("schema") to rs.getString("name")
                    byType.getOrPut(key) { mutableListOf() }.add(rs.getString("value"))
                }
            }
        }
        val enums = byType.map { (key, values) -> EnumTypeInfo(schema = key.first, name = key.second, values = values) }
        val byBareName = mutableMapOf<String, List<String>>()
        for ((key, values) in byType) byBareName[key.second] = values
        return enums to byBareName
    }

    private data class PartitionMeta(val isPartitioned: Boolean, val partitionOf: String?)

    /**
     * Partition flags need their own `pg_inherits` query; `pg_inherits` also covers classic INHERITS,
     * so the parent's `relkind` ('p' vs 'r') is the only way to tell partitioning from inheritance.
     */
    private fun partitionMeta(connection: Connection): Map<String, PartitionMeta> {
        val map = mutableMapOf<String, PartitionMeta>()
        connection.createStatement().use { st ->
            st.executeQuery(
                """
                SELECT n.nspname AS schema, c.relname AS name,
                       c.relkind = 'p' AS is_partitioned,
                       (SELECT inhparent::regclass::text FROM pg_inherits
                        WHERE inhrelid = c.oid AND (SELECT relkind FROM pg_class WHERE oid = inhparent) = 'p'
                        LIMIT 1) AS partition_of
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    val key = "${rs.getString("schema")}.${rs.getString("name")}"
                    map[key] = PartitionMeta(rs.getBoolean("is_partitioned"), rs.getString("partition_of"))
                }
            }
        }
        return map
    }

    /** Functions/procedures with volatility; powers the prompt's "CALLABLE READ-ONLY FUNCTIONS" section (only IMMUTABLE/STABLE functions are ever offered to the model, see [com.rahulmahadik.asksql.ide.engine.CatalogPruner.formatCatalogForPrompt]). */
    private fun routines(connection: Connection): List<RoutineInfo> {
        val list = mutableListOf<RoutineInfo>()
        connection.createStatement().use { st ->
            st.executeQuery(
                """
                SELECT n.nspname AS schema, p.proname AS name,
                       pg_get_function_identity_arguments(p.oid) AS args,
                       pg_get_function_result(p.oid) AS returns,
                       l.lanname AS language, p.provolatile AS volatility,
                       p.prosecdef AS secdef, p.prokind AS kind
                FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                JOIN pg_language l ON l.oid = p.prolang
                WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f','p')
                ORDER BY n.nspname, p.proname
                """.trimIndent(),
            ).use { rs ->
                while (rs.next()) {
                    val volatility = when (rs.getString("volatility")) {
                        "i" -> RoutineVolatility.IMMUTABLE
                        "s" -> RoutineVolatility.STABLE
                        "v" -> RoutineVolatility.VOLATILE
                        else -> RoutineVolatility.UNKNOWN
                    }
                    list += RoutineInfo(
                        schema = rs.getString("schema"),
                        name = rs.getString("name"),
                        kind = if (rs.getString("kind") == "p") RoutineKind.PROCEDURE else RoutineKind.FUNCTION,
                        args = rs.getString("args") ?: "",
                        returns = rs.getString("returns"),
                        language = rs.getString("language"),
                        volatility = volatility,
                        securityDefiner = rs.getBoolean("secdef"),
                    )
                }
            }
        }
        return list
    }
}
