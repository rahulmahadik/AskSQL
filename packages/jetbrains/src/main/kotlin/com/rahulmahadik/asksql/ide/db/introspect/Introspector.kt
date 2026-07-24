package com.rahulmahadik.asksql.ide.db.introspect

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import java.sql.Connection

fun interface Introspector {
    fun introspect(connection: Connection): SchemaCatalog
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
