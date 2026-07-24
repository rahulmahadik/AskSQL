package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.db.introspect.Introspectors
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import org.testcontainers.containers.MySQLContainer

/**
 * Proves [JdbcConnectionFactory] connects to a MySQL mandating TLS (`--require-secure-transport=ON`).
 * `sslMode=trust` is required: mariadb-java-client never attempts TLS on its own otherwise.
 */
@Category(IntegrationTest::class)
class MySqlSslIntegrationTest {

    private lateinit var container: MySQLContainer<*>

    @Before
    fun startContainer() {
        container = MySQLContainer("mysql:8.4").withCommand("--require-secure-transport=ON")
        container.start()
    }

    @After
    fun stopContainer() {
        container.stop()
    }

    @Test
    fun `JdbcConnectionFactory connects to a server that mandates TLS`() = runTest {
        val descriptor = ConnectionDescriptor(
            id = "mysql-ssl-required",
            name = "mysql-ssl-required",
            engine = EngineKind.MYSQL,
            scope = ConnectionScope.PROJECT,
            host = container.host,
            port = container.getMappedPort(3306),
            database = container.databaseName,
            user = container.username,
        )
        val connection = JdbcConnectionFactory.open(descriptor, container.password)
        val catalog = Introspectors.forEngine(EngineKind.MYSQL).introspect(connection)
        assertTrue("expected the introspector to run successfully over the encrypted connection", catalog.schemas.isNotEmpty())
        connection.close()
    }
}
