package com.rahulmahadik.asksql.ide.db

import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.util.io.HttpRequests
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.EngineKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.mariadb.jdbc.Driver as MariaDbDriver
import org.postgresql.Driver as PgDriver
import org.sqlite.JDBC as SqliteDriver
import java.net.URLClassLoader
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.sql.Driver
import kotlin.io.path.exists

/**
 * Resolves a [Driver] per engine via direct `Driver.connect`, never `DriverManager` (it cannot see a
 * plugin classloader's drivers). DuckDB and Oracle are lazy-downloaded, SHA-256 verified, and loaded in an isolated [URLClassLoader].
 */
object DriverProvisioner {

    private val LOG = Logger.getInstance(DriverProvisioner::class.java)
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 30_000

    // Verified against Maven Central on 2026-07-16; re-verify (version AND hash) before bumping.
    // The hash is pinned in source as the trust root, never fetched from Maven's own .sha256 file.
    private const val DUCKDB_VERSION = "1.5.4.0"
    private const val DUCKDB_SHA256 = "6bfca0c795f78bab000de41e848e730011d5c3834592042460d5fe2bd68218fd"
    private const val DUCKDB_GROUP_PATH = "org/duckdb/duckdb_jdbc"
    private val DUCKDB_MAVEN_URL =
        "https://repo1.maven.org/maven2/$DUCKDB_GROUP_PATH/$DUCKDB_VERSION/duckdb_jdbc-$DUCKDB_VERSION.jar"

    // Verified against Maven Central on 2026-07-16; re-verify (version AND hash) before bumping.
    // Same pinned-in-source trust root as DuckDB above.
    private const val ORACLE_VERSION = "23.26.2.0.0"
    private const val ORACLE_SHA256 = "dbc0ff940bc056d5d9b8f42c0946ded4ebbc08c25cecf6ec1e521b2c8216956b"
    private const val ORACLE_GROUP_PATH = "com/oracle/database/jdbc/ojdbc11"
    private val ORACLE_MAVEN_URL =
        "https://repo1.maven.org/maven2/$ORACLE_GROUP_PATH/$ORACLE_VERSION/ojdbc11-$ORACLE_VERSION.jar"

    fun driverFor(engine: EngineKind): Driver = when (engine) {
        EngineKind.POSTGRES -> PgDriver()
        EngineKind.MYSQL -> MariaDbDriver()
        EngineKind.SQLITE -> SqliteDriver()
        EngineKind.DUCKDB -> throw IllegalStateException("DuckDB driver must be resolved asynchronously via duckDbDriver()")
        EngineKind.ORACLE -> throw IllegalStateException("Oracle driver must be resolved asynchronously via oracleDriver()")
        EngineKind.MONGODB -> error("MongoDB has no JDBC driver - see MongoClientFactory")
    }

    // @Volatile fast path; the Mutex serializes download-and-cache so concurrent first calls can't double-download or leak a classloader.
    @Volatile private var cachedDuckDbClassLoader: URLClassLoader? = null
    @Volatile private var cachedOracleClassLoader: URLClassLoader? = null
    private val driverInitLock = Mutex()

    /** Downloads (if needed), verifies, and loads the DuckDB JDBC driver. Safe to call repeatedly and concurrently; the jar and classloader are cached. */
    suspend fun duckDbDriver(explicitJarPath: String? = null): Driver = withContext(Dispatchers.IO) {
        val loader = cachedDuckDbClassLoader ?: driverInitLock.withLock {
            cachedDuckDbClassLoader ?: run {
                val jarPath = explicitJarPath?.let { Path.of(it) }
                    ?: ensureDownloaded("duckdb_jdbc-$DUCKDB_VERSION.jar", "duckdb-download", DUCKDB_MAVEN_URL, DUCKDB_SHA256, "DuckDB")
                URLClassLoader(arrayOf(jarPath.toUri().toURL()), DriverProvisioner::class.java.classLoader)
                    .also { cachedDuckDbClassLoader = it }
            }
        }
        val driverClass = Class.forName("org.duckdb.DuckDBDriver", true, loader)
        driverClass.getDeclaredConstructor().newInstance() as Driver
    }

    /** Same lazy-download/verify/isolated-classloader pattern as [duckDbDriver], for Oracle's `ojdbc11`. */
    suspend fun oracleDriver(explicitJarPath: String? = null): Driver = withContext(Dispatchers.IO) {
        val loader = cachedOracleClassLoader ?: driverInitLock.withLock {
            cachedOracleClassLoader ?: run {
                val jarPath = explicitJarPath?.let { Path.of(it) }
                    ?: ensureDownloaded("ojdbc11-$ORACLE_VERSION.jar", "oracle-download", ORACLE_MAVEN_URL, ORACLE_SHA256, "Oracle")
                URLClassLoader(arrayOf(jarPath.toUri().toURL()), DriverProvisioner::class.java.classLoader)
                    .also { cachedOracleClassLoader = it }
            }
        }
        val driverClass = Class.forName("oracle.jdbc.OracleDriver", true, loader)
        driverClass.getDeclaredConstructor().newInstance() as Driver
    }

    private fun driversDir(): Path {
        val dir = Path.of(PathManager.getSystemPath(), "asksql", "drivers")
        Files.createDirectories(dir)
        return dir
    }

    private fun ensureDownloaded(fileName: String, tempPrefix: String, mavenUrl: String, expectedSha256: String, driverLabel: String): Path {
        val target = driversDir().resolve(fileName)
        if (target.exists() && verifySha256(target, expectedSha256)) return target

        // Sweep .tmp orphans from a prior hard-kill; the Mutex guarantees no concurrent download is using one.
        Files.newDirectoryStream(driversDir(), "*.jar.tmp").use { it.forEach { p -> Files.deleteIfExists(p) } }

        LOG.info("Downloading $driverLabel JDBC driver from Maven Central")
        val tmp = Files.createTempFile(driversDir(), tempPrefix, ".jar.tmp")
        try {
            try {
                // Explicit timeouts: coroutine cancellation cannot interrupt this blocking network call.
                HttpRequests.request(mavenUrl).connectTimeout(CONNECT_TIMEOUT_MS).readTimeout(READ_TIMEOUT_MS).saveToFile(tmp.toFile(), null)
            } catch (e: Exception) {
                throw AskSqlException(
                    AskSqlErrorCode.DB_UNREACHABLE,
                    userMessage = "Could not download the $driverLabel driver. Check your network connection or configure a driver jar path in AskSQL settings.",
                    detail = e.message,
                    cause = e,
                )
            }
            val actualHash = sha256Hex(tmp)
            if (!actualHash.equals(expectedSha256, ignoreCase = true)) {
                throw AskSqlException(
                    AskSqlErrorCode.DB_UNREACHABLE,
                    userMessage = "The downloaded $driverLabel driver failed integrity verification and was discarded.",
                    detail = "expected=$expectedSha256 actual=$actualHash",
                )
            }
            Files.move(tmp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE)
        } finally {
            Files.deleteIfExists(tmp)
        }
        return target
    }

    private fun verifySha256(file: Path, expectedSha256: String): Boolean =
        sha256Hex(file).equals(expectedSha256, ignoreCase = true)

    private fun sha256Hex(file: Path): String {
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(file).use { stream ->
            val buffer = ByteArray(8192)
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
