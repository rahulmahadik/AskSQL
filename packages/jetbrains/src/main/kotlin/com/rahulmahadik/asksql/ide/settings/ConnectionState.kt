package com.rahulmahadik.asksql.ide.settings

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.SslMode
import com.rahulmahadik.asksql.ide.model.EngineKind

/** The persisted (XML-serializable) shape of a connection, kept separate from [ConnectionDescriptor]. Never carries a password. */
data class ConnectionState(
    @JvmField var id: String = "",
    @JvmField var name: String = "",
    @JvmField var engine: String = "",
    @JvmField var host: String? = null,
    @JvmField var port: Int? = null,
    @JvmField var database: String? = null,
    @JvmField var user: String? = null,
    @JvmField var filePath: String? = null,
    @JvmField var connectionString: String? = null,
    @JvmField var isSample: Boolean = false,
    /** [SslMode.name]; null falls back to [SslMode.TRUST]. */
    @JvmField var sslMode: String? = null,
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
