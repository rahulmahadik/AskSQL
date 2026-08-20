package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import java.sql.Connection

interface Introspector {
    /**
     * [nameKeys] carries the host's cell-value opt-in. A JSON column's key NAMES are data - a map with a
     * stable key set is structurally identical to a record - so the default states how many recur, not
     * which. See ColumnHints.jsonHint.
     */
    fun introspect(connection: Connection, nameKeys: Boolean = false): SchemaCatalog
}

object Introspectors {
    fun forEngine(engine: EngineKind): Introspector = when (engine) {
        EngineKind.POSTGRES -> PostgresIntrospector
        EngineKind.MYSQL -> MySqlIntrospector
        EngineKind.SQLITE -> SqliteIntrospector
        EngineKind.DUCKDB -> DuckDbIntrospector
        EngineKind.ORACLE -> OracleIntrospector
        EngineKind.MONGODB -> error("MongoDB has no java.sql.Connection to introspect - see MongoIntrospector")
    }
}
