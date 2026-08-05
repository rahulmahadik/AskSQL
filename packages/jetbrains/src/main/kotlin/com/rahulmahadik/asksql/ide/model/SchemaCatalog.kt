package com.rahulmahadik.asksql.ide.model

import java.time.Instant

data class ColumnInfo(
    val name: String,
    val dbType: String,
    val nullable: Boolean,
    val default: String? = null,
    val generated: Boolean = false,
    val comment: String? = null,
    /** Populated for enum-typed columns so WHERE literals use real values. */
    val enumValues: List<String> = emptyList(),
    /** Observed values (opt-in, data not schema) for low-cardinality columns, not a declared enum. */
    val sampledValues: List<String> = emptyList(),
)

data class ForeignKeyInfo(
    val name: String? = null,
    val columns: List<String>,
    val refSchema: String? = null,
    val refTable: String,
    val refColumns: List<String>,
)

data class IndexInfo(
    val name: String,
    val columns: List<String>,
    val unique: Boolean,
    val method: String? = null,
    val predicate: String? = null,
    val definition: String? = null,
)

enum class TriggerTiming { BEFORE, AFTER, INSTEAD_OF, UNKNOWN }

data class TriggerInfo(
    val name: String,
    val schema: String? = null,
    val table: String,
    val timing: TriggerTiming,
    val events: List<String>,
    val enabled: Boolean,
    val definition: String? = null,
)

enum class RoutineKind { FUNCTION, PROCEDURE }
enum class RoutineVolatility { IMMUTABLE, STABLE, VOLATILE, UNKNOWN }

data class RoutineInfo(
    val schema: String? = null,
    val name: String,
    val kind: RoutineKind,
    val args: String,
    val returns: String? = null,
    val language: String? = null,
    /** Only IMMUTABLE/STABLE routines are offered to the model as callable; VOLATILE/UNKNOWN are listed but never called. */
    val volatility: RoutineVolatility,
    val securityDefiner: Boolean = false,
    val source: String? = null,
)

enum class TableKind { TABLE, VIEW, MATERIALIZED_VIEW }

/** 'FILE' for tables created from an upload (DuckDB), 'DB' otherwise. */
enum class TableSource { DB, FILE }

data class TableInfo(
    val schema: String? = null,
    val name: String,
    val kind: TableKind,
    val columns: List<ColumnInfo>,
    val primaryKey: List<String> = emptyList(),
    val foreignKeys: List<ForeignKeyInfo> = emptyList(),
    val uniques: List<List<String>> = emptyList(),
    val checks: List<String> = emptyList(),
    val indexes: List<IndexInfo> = emptyList(),
    val comment: String? = null,
    val rowEstimate: Long? = null,
    val isPartitioned: Boolean = false,
    val partitionOf: String? = null,
    val definition: String? = null,
    val source: TableSource = TableSource.DB,
)

data class EnumTypeInfo(val schema: String? = null, val name: String, val values: List<String>)
data class SequenceInfo(val schema: String? = null, val name: String, val ownedBy: String? = null)

data class SchemaCatalog(
    val engine: EngineKind,
    val schemas: List<String> = emptyList(),
    val tables: List<TableInfo> = emptyList(),
    val enums: List<EnumTypeInfo> = emptyList(),
    val sequences: List<SequenceInfo> = emptyList(),
    val triggers: List<TriggerInfo> = emptyList(),
    val routines: List<RoutineInfo> = emptyList(),
    val extensions: List<String> = emptyList(),
    /** Permission problems, skipped objects, ... - surfaced, never fatal. */
    val warnings: List<String> = emptyList(),
    val fetchedAt: Instant = Instant.now(),
)
