package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.EngineKind

/** Where a [ConnectionDescriptor] was defined; drives [com.rahulmahadik.asksql.ide.settings.ConnectionMerger]'s precedence. */
enum class ConnectionScope { APPLICATION, PROJECT }

/** Transport encryption for Postgres/MySQL. [TRUST] (default): opportunistic, no cert check. [VERIFY]: validates against the platform truststore. [DISABLE]: no encryption. */
enum class SslMode { TRUST, VERIFY, DISABLE }

/**
 * The domain model for a configured connection, never directly (de)serialized (see `ConnectionState` /
 * `ConnectionMerger`). Never carries a password; that lives only in PasswordSafe, keyed by [id].
 */
data class ConnectionDescriptor(
    val id: String,
    val name: String,
    val engine: EngineKind,
    val scope: ConnectionScope,
    val host: String? = null,
    val port: Int? = null,
    val database: String? = null,
    val user: String? = null,
    /** SQLite/DuckDB file-mode path. */
    val filePath: String? = null,
    /**
     * MongoDB `mongodb://`/`mongodb+srv://` connection string, never with embedded credentials: the
     * password travels via PasswordSafe and is applied at connect time via `MongoCredential`.
     */
    val connectionString: String? = null,
    /** Marks the bundled onboarding demo connection; see `TrySampleDataAction`. */
    val isSample: Boolean = false,
    /** Postgres/MySQL only; ignored by every other engine. See [SslMode]'s doc. */
    val sslMode: SslMode = SslMode.TRUST,
) {
    /** A stable, non-secret identity string PasswordSafe binds the stored password to (see `AskSqlSecrets`). */
    fun endpointIdentity(): String = when (engine) {
        EngineKind.SQLITE, EngineKind.DUCKDB -> "$engine:${filePath.orEmpty()}"
        EngineKind.MONGODB -> "$engine:${connectionString.orEmpty()}:${user.orEmpty()}"
        else -> "$engine:${host.orEmpty()}:${port ?: 0}:${database.orEmpty()}:${user.orEmpty()}"
    }

    /** "where does this actually point at", for display. File engines show the file (or in-memory), not a host:port they don't have. */
    fun target(): String = when (engine) {
        EngineKind.SQLITE, EngineKind.DUCKDB -> filePath?.takeIf { it.isNotBlank() } ?: "in-memory"
        EngineKind.MONGODB -> connectionString.orEmpty()
        else -> "${host.orEmpty()}:${port ?: "?"}/${database ?: "?"}"
    }
}
