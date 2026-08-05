package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.EngineKind
import java.sql.Connection

/**
 * Defense in depth beyond the SQL guard: the JDBC session itself refuses writes. `setReadOnly()` is
 * only an optimizer hint on several drivers; the per-engine statements below reject writes at the server/driver.
 */
object ReadOnlySession {

    /** Applied once, immediately after a connection is opened and before any user SQL runs on it. */
    fun enforce(connection: Connection, engine: EngineKind) {
        connection.isReadOnly = true // harmless hint; the real enforcement follows
        when (engine) {
            EngineKind.POSTGRES -> connection.createStatement().use {
                it.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                it.execute("SET default_transaction_read_only = on")
            }
            EngineKind.MYSQL -> connection.createStatement().use {
                it.execute("SET SESSION TRANSACTION READ ONLY")
            }
            EngineKind.SQLITE -> {
                // Enforced at connect time via SQLiteConfig.setReadOnly(true); SQLite has no per-session statement for this.
            }
            EngineKind.DUCKDB -> {
                // Enforced at connect time via the duckdb.read_only=true JDBC property; DuckDB has no read-only pragma.
            }
            EngineKind.ORACLE -> {
                // Oracle's read-only transaction covers only itself, not the session; JdbcExecutor re-arms it per query.
            }
            EngineKind.MONGODB -> error("MongoDB has no JDBC session - see MongoClientFactory/MongoGuard")
        }
    }
}
