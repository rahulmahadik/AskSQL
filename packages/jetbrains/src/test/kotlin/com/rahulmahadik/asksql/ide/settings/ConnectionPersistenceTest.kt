package com.rahulmahadik.asksql.ide.settings

import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.model.EngineKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** Connections must survive closing the IDE. */
class ConnectionPersistenceTest {

    private fun sample(id: String) = ConnectionState(
        id = id,
        name = "Prod $id",
        engine = "postgres",
        host = "db.example",
        port = 5432,
        database = "app",
        user = "reader",
        sslMode = "VERIFY",
    )

    @Test fun `state written to project settings is returned by getState`() {
        val settings = AskSqlProjectSettings()
        settings.connections = listOf(sample("a"), sample("b"))

        val persisted = settings.state
        assertEquals(2, persisted.connections.size)
        assertEquals("a", persisted.connections[0].id)
        assertEquals("Prod b", persisted.connections[1].name)
    }

    @Test fun `a fresh instance loading that state has the connections back`() {
        val original = AskSqlProjectSettings()
        original.connections = listOf(sample("a"), sample("b"))

        // What the platform does on the next IDE start: construct, then hand back the stored state.
        val reopened = AskSqlProjectSettings()
        reopened.loadState(original.state)

        assertEquals(2, reopened.connections.size)
        assertEquals(listOf("a", "b"), reopened.connections.map { it.id })
    }

    @Test fun `every field a connection needs survives the round trip`() {
        val original = AskSqlProjectSettings()
        original.connections = listOf(sample("a"))

        val reopened = AskSqlProjectSettings()
        reopened.loadState(original.state)
        val back = reopened.connections.single()

        assertEquals("a", back.id)
        assertEquals("Prod a", back.name)
        assertEquals("postgres", back.engine)
        assertEquals("db.example", back.host)
        assertEquals(5432, back.port)
        assertEquals("app", back.database)
        assertEquals("reader", back.user)
        assertEquals("VERIFY", back.sslMode)
    }

    @Test fun `a restored state converts back into a usable descriptor`() {
        val original = AskSqlProjectSettings()
        original.connections = listOf(sample("a"))

        val reopened = AskSqlProjectSettings()
        reopened.loadState(original.state)
        val descriptor = reopened.connections.single().toDescriptor(ConnectionScope.PROJECT)

        assertNotNull(descriptor)
        assertEquals(EngineKind.POSTGRES, descriptor.engine)
        assertEquals("db.example", descriptor.host)
        assertEquals(ConnectionScope.PROJECT, descriptor.scope)
    }

    @Test fun `application scoped connections persist too`() {
        val app = AskSqlAppSettings()
        app.connections = listOf(sample("global"))

        val reopened = AskSqlAppSettings()
        reopened.loadState(app.state)

        assertEquals(1, reopened.connections.size)
        assertEquals("global", reopened.connections.single().id)
    }
}
