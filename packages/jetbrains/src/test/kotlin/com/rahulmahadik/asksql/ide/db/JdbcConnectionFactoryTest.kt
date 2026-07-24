package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.EngineKind
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** host/database are interpolated raw into the JDBC URL; a value with `/?#&@` or whitespace could inject extra connection parameters, and a project-scoped connection lives in committed `.idea/asksql.xml`. */
class JdbcConnectionFactoryTest {

    private fun descriptor(engine: EngineKind, host: String? = "localhost", database: String? = "db", port: Int? = null) =
        ConnectionDescriptor(id = "t", name = "t", engine = engine, scope = ConnectionScope.PROJECT, host = host, database = database, port = port)

    private suspend fun assertConfigError(descriptor: ConnectionDescriptor) {
        var thrown: AskSqlException? = null
        try {
            JdbcConnectionFactory.open(descriptor, password = null)
        } catch (e: AskSqlException) {
            thrown = e
        }
        assertNotNull("expected a CONFIG_ERROR before any connection attempt", thrown)
        assertEquals(AskSqlErrorCode.CONFIG_ERROR, thrown!!.code)
    }

    @Test fun `rejects a database name carrying an injected JDBC parameter`() = runTest {
        assertConfigError(descriptor(EngineKind.MYSQL, database = "db?autoDeserialize=true"))
    }

    @Test fun `rejects a database name carrying a path segment`() = runTest {
        assertConfigError(descriptor(EngineKind.POSTGRES, database = "db/../other"))
    }

    @Test fun `rejects a host containing an ampersand-injected parameter`() = runTest {
        assertConfigError(descriptor(EngineKind.ORACLE, host = "localhost&oracle.jdbc.J2EE13Compliant=true"))
    }

    @Test fun `rejects a host containing whitespace`() = runTest {
        assertConfigError(descriptor(EngineKind.POSTGRES, host = "local host"))
    }

    @Test fun `rejects a port below 1`() = runTest {
        assertConfigError(descriptor(EngineKind.POSTGRES, port = 0))
    }

    @Test fun `rejects a port above 65535`() = runTest {
        assertConfigError(descriptor(EngineKind.MYSQL, port = 70000))
    }

    @Test fun `an ordinary host and database do not trip the validator`() = runTest {
        // Should fail with DB_UNREACHABLE (no such server), never CONFIG_ERROR: proves the
        // validator doesn't false-positive on legitimate values.
        var thrown: AskSqlException? = null
        try {
            JdbcConnectionFactory.open(descriptor(EngineKind.POSTGRES, host = "127.0.0.1", database = "my_db-01", port = 1), password = null)
        } catch (e: AskSqlException) {
            thrown = e
        }
        assertNotNull(thrown)
        assertEquals(AskSqlErrorCode.DB_UNREACHABLE, thrown!!.code)
    }
}
