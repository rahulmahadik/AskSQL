package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.experimental.categories.Category

/**
 * A refused password must not read as an unreachable server. Runs against the local databases used
 * by the other integration suites; a case is skipped when its server is not up.
 */
@Category(IntegrationTest::class)
class ConnectErrorClassificationTest {

    private fun descriptor(engine: EngineKind, host: String, port: Int, database: String, user: String) =
        ConnectionDescriptor(
            id = "auth-$engine",
            name = "auth-$engine",
            engine = engine,
            scope = ConnectionScope.PROJECT,
            host = host,
            port = port,
            database = database,
            user = user,
        )

    /** The code for a connect attempt, or null when the server is not reachable at all to test against. */
    private suspend fun codeFor(descriptor: ConnectionDescriptor, password: String?): AskSqlErrorCode? =
        try {
            JdbcConnectionFactory.open(descriptor, password).close()
            null
        } catch (e: com.rahulmahadik.asksql.ide.errors.AskSqlException) {
            e.code
        }

    private suspend fun serverIsUp(descriptor: ConnectionDescriptor, goodPassword: String?): Boolean =
        codeFor(descriptor, goodPassword) == null

    @Test
    fun `a wrong password is reported as refused credentials, not as an unreachable server`() = runTest {
        val engines = listOf(
            Triple(descriptor(EngineKind.POSTGRES, "localhost", 5432, "asksql_e2e", "postgres"), "root", "WRONG_PASSWORD"),
            Triple(descriptor(EngineKind.MYSQL, "127.0.0.1", 53306, "asksql_e2e", "root"), "", "WRONG_PASSWORD"),
        )
        var checked = 0
        for ((descriptor, goodPassword, wrongPassword) in engines) {
            if (!serverIsUp(descriptor, goodPassword)) {
                println("[skip] ${descriptor.engine} is not running locally")
                continue
            }
            checked++
            assertEquals(
                "${descriptor.engine}: a refused password must not read as an unreachable server",
                AskSqlErrorCode.DB_AUTH,
                codeFor(descriptor, wrongPassword),
            )
        }
        println("[connect-errors] checked $checked engine(s)")
    }

    @Test
    fun `a database name that does not exist is reported as such`() = runTest {
        val descriptor = descriptor(EngineKind.POSTGRES, "localhost", 5432, "no_such_database_here", "postgres")
        val live = descriptor(EngineKind.POSTGRES, "localhost", 5432, "asksql_e2e", "postgres")
        if (!serverIsUp(live, "root")) {
            println("[skip] postgres is not running locally")
            return@runTest
        }
        assertEquals(AskSqlErrorCode.DB_NOT_FOUND, codeFor(descriptor, "root"))
    }

    @Test
    fun `a port nothing is listening on is still reported as unreachable`() = runTest {
        val descriptor = descriptor(EngineKind.POSTGRES, "localhost", 59997, "asksql_e2e", "postgres")
        assertEquals(AskSqlErrorCode.DB_UNREACHABLE, codeFor(descriptor, "root"))
    }
}
