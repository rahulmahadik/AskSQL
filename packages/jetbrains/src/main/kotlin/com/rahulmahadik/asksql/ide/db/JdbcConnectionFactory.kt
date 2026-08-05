package com.rahulmahadik.asksql.ide.db

import com.intellij.openapi.diagnostic.Logger
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.EngineKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.sql.Connection
import java.sql.SQLException
import java.util.Properties

/**
 * Opens a live, read-only-enforced [Connection] for a [ConnectionDescriptor],
 * resolving the driver via [DriverProvisioner] (never `DriverManager`).
 */
object JdbcConnectionFactory {

    private val LOG = Logger.getInstance(JdbcConnectionFactory::class.java)

    /** `host`/`database` are interpolated raw into the JDBC URL, where these characters can inject driver parameters (e.g. MySQL's `autoDeserialize`). */
    private val UNSAFE_URL_CHARS = Regex("""[/?#&@\s]""")

    private fun requireSafeUrlSegment(value: String?, fieldName: String): String? {
        if (value != null && UNSAFE_URL_CHARS.containsMatchIn(value)) {
            throw AskSqlException(
                AskSqlErrorCode.CONFIG_ERROR,
                userMessage = "The connection's $fieldName contains a character that isn't allowed there (/, ?, #, &, @, or whitespace).",
            )
        }
        return value
    }

    /** File paths legitimately contain `/`, so [UNSAFE_URL_CHARS] doesn't apply; `?`/`#`/`;` still carry JDBC-URL meaning and can smuggle driver options past [ReadOnlySession]. */
    private val UNSAFE_FILE_PATH_CHARS = Regex("""[?#;]""")

    private fun requireSafeFilePath(value: String, fieldName: String): String {
        if (UNSAFE_FILE_PATH_CHARS.containsMatchIn(value)) {
            throw AskSqlException(
                AskSqlErrorCode.CONFIG_ERROR,
                userMessage = "The connection's $fieldName contains a character that isn't allowed there (?, #, or ;).",
            )
        }
        return value
    }

    private fun requireValidPort(port: Int?): Int? {
        if (port != null && port !in 1..65535) {
            throw AskSqlException(AskSqlErrorCode.CONFIG_ERROR, userMessage = "The connection's port must be between 1 and 65535.")
        }
        return port
    }

    /** These connections never create a file; a missing one opened read-only fails with a cryptic driver IO error. */
    private fun requireExistingFile(path: String, engineName: String): String {
        if (path != ":memory:" && !java.io.File(path).isFile) {
            throw AskSqlException(
                AskSqlErrorCode.CONFIG_ERROR,
                userMessage = "This $engineName file doesn't exist: $path",
            )
        }
        return path
    }

    suspend fun open(
        descriptor: ConnectionDescriptor,
        password: String?,
        duckDbDriverJarPath: String? = null,
        oracleDriverJarPath: String? = null,
    ): Connection =
        withContext(Dispatchers.IO) {
            val (url, props) = jdbcUrlAndProps(descriptor, password)
            // Checkpoint logging: the timestamps show which phase (driver resolution, driver.connect, ReadOnlySession.enforce) a hang is stuck in.
            LOG.info("AskSQL: opening ${descriptor.engine} connection to ${descriptor.host ?: descriptor.filePath ?: "?"}:${descriptor.port ?: "-"} (id=${descriptor.id})")
            val startNanos = System.nanoTime()
            val driver = when (descriptor.engine) {
                EngineKind.DUCKDB -> DriverProvisioner.duckDbDriver(duckDbDriverJarPath)
                EngineKind.ORACLE -> DriverProvisioner.oracleDriver(oracleDriverJarPath)
                else -> DriverProvisioner.driverFor(descriptor.engine)
            }
            LOG.info("AskSQL: driver resolved after ${(System.nanoTime() - startNanos) / 1_000_000}ms, calling driver.connect()")
            val connection = try {
                driver.connect(url, props) ?: throw AskSqlException(
                    AskSqlErrorCode.DB_UNREACHABLE,
                    userMessage = "The database driver didn't accept that connection. Check the host, port, and database name.",
                    detail = "driver.connect returned null for $url",
                )
            } catch (e: SQLException) {
                LOG.info("AskSQL: driver.connect() threw after ${(System.nanoTime() - startNanos) / 1_000_000}ms total: ${e.message}")
                throw AskSqlException(AskSqlErrorCode.DB_UNREACHABLE, detail = e.message, cause = e)
            }
            LOG.info("AskSQL: driver.connect() returned after ${(System.nanoTime() - startNanos) / 1_000_000}ms total, enforcing read-only")
            ReadOnlySession.enforce(connection, descriptor.engine)
            LOG.info("AskSQL: connection ready after ${(System.nanoTime() - startNanos) / 1_000_000}ms total")
            connection
        }

    private fun jdbcUrlAndProps(descriptor: ConnectionDescriptor, password: String?): Pair<String, Properties> {
        val props = Properties()
        return when (descriptor.engine) {
            EngineKind.POSTGRES -> {
                val host = requireSafeUrlSegment(descriptor.host, "host")
                val database = requireSafeUrlSegment(descriptor.database, "database")
                val port = requireValidPort(descriptor.port)
                // TRUST maps to pgjdbc's own "prefer" default (opportunistic encryption, no certificate check); VERIFY also validates against the platform truststore.
                val sslmode = when (descriptor.sslMode) {
                    SslMode.DISABLE -> "disable"
                    SslMode.VERIFY -> "verify-full"
                    SslMode.TRUST -> "prefer"
                }
                // connectTimeout bounds only the TCP handshake, so socketTimeout covers a server that goes silent after it; both are in seconds.
                val url = "jdbc:postgresql://$host:${port ?: 5432}/$database" +
                    "?readOnlyMode=always&connectTimeout=10&socketTimeout=15&sslmode=$sslmode"
                descriptor.user?.let { props.setProperty("user", it) }
                password?.let { props.setProperty("password", it) }
                props.setProperty("ApplicationName", "AskSQL") // visible in pg_stat_activity, so a DBA can attribute this plugin's load
                url to props
            }
            EngineKind.MYSQL -> {
                val host = requireSafeUrlSegment(descriptor.host, "host")
                val database = requireSafeUrlSegment(descriptor.database, "database")
                val port = requireValidPort(descriptor.port)
                // sslMode=trust encrypts opportunistically without certificate verification, matching pgjdbc's "prefer" above.
                // MySQL 8+'s default caching_sha2_password auth plugin needs TLS (or RSA key retrieval) to exchange the password at all.
                val mariadbSslMode = when (descriptor.sslMode) {
                    SslMode.DISABLE -> "disable"
                    SslMode.VERIFY -> "verify-full"
                    SslMode.TRUST -> "trust"
                }
                // connectTimeout/socketTimeout are in milliseconds for mariadb-java-client, lowered from its 30s default to 10s/15s.
                val url = "jdbc:mariadb://$host:${port ?: 3306}/$database" +
                    "?permitMysqlScheme=true&useReadAheadInput=false&sslMode=$mariadbSslMode&connectTimeout=10000&socketTimeout=15000"
                descriptor.user?.let { props.setProperty("user", it) }
                password?.let { props.setProperty("password", it) }
                props.setProperty("connectionAttributes", "program_name:AskSQL") // visible in performance_schema.session_connect_attrs
                url to props
            }
            EngineKind.SQLITE -> {
                val path = requireExistingFile(
                    requireSafeFilePath(
                        descriptor.filePath ?: throw AskSqlException(
                            AskSqlErrorCode.CONFIG_ERROR,
                            userMessage = "This SQLite connection has no file path configured.",
                        ),
                        "file path",
                    ),
                    "SQLite",
                )
                val config = org.sqlite.SQLiteConfig()
                config.setReadOnly(true)
                ("jdbc:sqlite:$path") to config.toProperties()
            }
            EngineKind.DUCKDB -> {
                val path = descriptor.filePath?.let { requireExistingFile(requireSafeFilePath(it, "file path"), "DuckDB") } ?: ":memory:"
                if (path != ":memory:") props.setProperty("duckdb.read_only", "true")
                ("jdbc:duckdb:$path") to props
            }
            EngineKind.ORACLE -> {
                val host = requireSafeUrlSegment(descriptor.host, "host")
                val database = requireSafeUrlSegment(descriptor.database, "database")
                val port = requireValidPort(descriptor.port)
                // descriptor.database is a service name, not a SID, hence the "/" form: a multitenant (12c+) pluggable database is reachable only by service name.
                val url = "jdbc:oracle:thin:@$host:${port ?: 1521}/$database"
                descriptor.user?.let { props.setProperty("user", it) }
                password?.let { props.setProperty("password", it) }
                props.setProperty("oracle.net.CONNECT_TIMEOUT", "10000")
                props.setProperty("oracle.net.READ_TIMEOUT", "30000") // CONNECT_TIMEOUT only bounds the handshake; a socket that goes silent after that would otherwise hang indefinitely
                props.setProperty("v\$session.program", "AskSQL") // visible in v$session, so a DBA can attribute this plugin's load
                url to props
            }
            EngineKind.MONGODB -> error("MongoDB has no JDBC URL - see MongoClientFactory")
        }
    }
}
