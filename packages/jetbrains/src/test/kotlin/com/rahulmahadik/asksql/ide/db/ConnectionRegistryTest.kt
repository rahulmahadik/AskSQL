package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.sql.Connection

/** Exercises [ConnectionRegistry] against a real SQLite in-memory connection: [invalidate] must never close a [Connection] a concurrent [ConnectionRegistry.withConnection] call is still using. */
class ConnectionRegistryTest {

    private fun registry(): ConnectionRegistry =
        ConnectionRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))

    private fun sqliteDescriptor(id: String = "test-conn") = ConnectionDescriptor(
        id = id,
        name = "test",
        engine = EngineKind.SQLITE,
        scope = ConnectionScope.PROJECT,
        filePath = ":memory:",
    )

    @Test
    fun `withConnection reuses the same connection across calls`() = runTest {
        val registry = registry()
        val descriptor = sqliteDescriptor()
        val first = registry.withConnection(descriptor, null) { it }
        val second = registry.withConnection(descriptor, null) { it }
        assertSame(first, second)
        first.close()
    }

    @Test
    fun `invalidate does not close a connection still leased by an in-flight operation`() = runTest {
        val registry = registry()
        val descriptor = sqliteDescriptor()
        val acquired = CompletableDeferred<Connection>()
        val releaseSignal = CompletableDeferred<Unit>()

        // Simulates a running chat query holding the connection open.
        val inFlight = launch(Dispatchers.Default) {
            registry.withConnection(descriptor, null) { connection ->
                acquired.complete(connection)
                releaseSignal.await()
            }
        }

        val connection = acquired.await()
        // Simulates the user hitting Apply/OK in Settings while that query is still running.
        registry.invalidate(descriptor.id)

        assertFalse(
            "a connection an in-flight operation is still using must not be closed by a concurrent invalidate()",
            connection.isClosed,
        )

        releaseSignal.complete(Unit)
        inFlight.join()

        assertTrue(
            "a superseded connection must be closed once its last lease ends",
            connection.isClosed,
        )
    }

    @Test
    fun `many concurrent first-time acquires for the same id open exactly one real connection`() = runTest {
        val registry = registry()
        val descriptor = sqliteDescriptor()

        val connections = (1..20).map {
            async { registry.withConnection(descriptor, null) { it } }
        }.awaitAll()

        val distinctByIdentity = connections.map { System.identityHashCode(it) }.toSet()
        assertEquals(1, distinctByIdentity.size)
        connections.first().close()
    }

    @Test
    fun `acquiring after invalidate opens a fresh connection`() = runTest {
        val registry = registry()
        val descriptor = sqliteDescriptor()
        val first = registry.withConnection(descriptor, null) { it }
        registry.invalidate(descriptor.id)
        assertTrue("an unleased connection is closed as soon as it is invalidated", first.isClosed)

        val second = registry.withConnection(descriptor, null) { it }
        assertNotSame(first, second)
        second.close()
    }

    /** [JdbcExecutor]'s lock map keys strongly on the [Connection], so a dropped one has to be released there too. */
    private fun perConnectionLocks(): Map<*, *> {
        val field = JdbcExecutor::class.java.getDeclaredField("perConnectionLocks")
        field.isAccessible = true
        return field.get(JdbcExecutor) as Map<*, *>
    }

    /** A connection that fails its validity probe - a server restart or a dropped VPN - is closed, not just unmapped. */
    @Test
    fun `a connection failing the validity probe is released, not only dropped`() = runTest {
        val registry = registry()
        val descriptor = sqliteDescriptor()
        val dead = registry.withConnection(descriptor, null) { it }
        JdbcExecutor.withConnectionLock(dead) { } // the entry every DuckDB and Oracle statement leaves behind
        dead.close()

        val fresh = registry.withConnection(descriptor, null) { it }
        assertNotSame(dead, fresh)
        assertFalse(
            "a dropped connection must not stay keyed in JdbcExecutor's per-connection lock map",
            perConnectionLocks().containsKey(dead),
        )
        fresh.close()
    }
}
