package com.rahulmahadik.asksql.ide.settings

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.SslMode
import com.rahulmahadik.asksql.ide.model.EngineKind

/**
 * The persisted (XML-serializable) shape of a connection, kept separate from [ConnectionDescriptor]
 * so a persisted-shape migration never touches engine/UI/db code. Never carries a password.
 */
data class ConnectionState(
    @JvmField val id: String = "",
    @JvmField val name: String = "",
    @JvmField val engine: String = "",
    @JvmField val host: String? = null,
    @JvmField val port: Int? = null,
    @JvmField val database: String? = null,
    @JvmField val user: String? = null,
    @JvmField val filePath: String? = null,
    @JvmField val connectionString: String? = null,
    @JvmField val isSample: Boolean = false,
    /** [SslMode.name], or null for pre-existing state written before this field existed; [toDescriptor] treats that the same as [SslMode.TRUST], its default. */
    @JvmField val sslMode: String? = null,
)

fun ConnectionState.toDescriptor(scope: ConnectionScope): ConnectionDescriptor = ConnectionDescriptor(
    id = id,
    name = name,
    engine = EngineKind.fromWireName(engine),
    scope = scope,
    host = host,
    port = port,
    database = database,
    user = user,
    filePath = filePath,
    connectionString = connectionString,
    isSample = isSample,
    sslMode = sslMode?.let { runCatching { SslMode.valueOf(it) }.getOrNull() } ?: SslMode.TRUST,
)

fun ConnectionDescriptor.toState(): ConnectionState = ConnectionState(
    id = id,
    name = name,
    engine = engine.wireName,
    host = host,
    port = port,
    database = database,
    user = user,
    filePath = filePath,
    connectionString = connectionString,
    isSample = isSample,
    sslMode = sslMode.name,
)
