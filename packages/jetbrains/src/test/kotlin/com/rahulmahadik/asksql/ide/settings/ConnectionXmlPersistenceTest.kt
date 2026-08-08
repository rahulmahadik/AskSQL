package com.rahulmahadik.asksql.ide.settings

import com.intellij.util.xmlb.XmlSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Restarting the IDE round-trips state through XML on disk. An in-memory `loadState(getState())`
 * never touches the serializer, so it cannot catch a field that fails to write or read back.
 */
class ConnectionXmlPersistenceTest {

    private val sample = ConnectionState(
        id = "c1",
        name = "Prod",
        engine = "postgres",
        host = "db.example",
        port = 5432,
        database = "app",
        user = "reader",
        sslMode = "VERIFY",
    )

    private fun roundTrip(state: AskSqlProjectState): AskSqlProjectState {
        val element = XmlSerializer.serialize(state)
        return XmlSerializer.deserialize(element, AskSqlProjectState::class.java)
    }

    @Test fun `connections survive a serialize and deserialize cycle`() {
        val back = roundTrip(AskSqlProjectState(connections = listOf(sample)))

        assertEquals(1, back.connections.size)
        assertEquals("c1", back.connections.single().id)
    }

    @Test fun `every connection field survives the XML cycle`() {
        val back = roundTrip(AskSqlProjectState(connections = listOf(sample))).connections.single()

        assertEquals("c1", back.id)
        assertEquals("Prod", back.name)
        assertEquals("postgres", back.engine)
        assertEquals("db.example", back.host)
        assertEquals(5432, back.port)
        assertEquals("app", back.database)
        assertEquals("reader", back.user)
        assertEquals("VERIFY", back.sslMode)
    }

    @Test fun `a file backed connection survives the XML cycle`() {
        val duck = ConnectionState(id = "d1", name = "Local", engine = "duckdb", filePath = "/tmp/a.duckdb")
        val back = roundTrip(AskSqlProjectState(connections = listOf(duck))).connections.single()

        assertEquals("/tmp/a.duckdb", back.filePath)
        assertEquals("duckdb", back.engine)
    }

    @Test fun `several connections keep their order and identity`() {
        val many = (1..5).map { sample.copy(id = "c$it", name = "Conn $it") }
        val back = roundTrip(AskSqlProjectState(connections = many))

        assertEquals((1..5).map { "c$it" }, back.connections.map { it.id })
    }

    @Test fun `the serialized XML actually contains the connection`() {
        val xml = XmlSerializer.serialize(AskSqlProjectState(connections = listOf(sample)))
        val text = com.intellij.openapi.util.JDOMUtil.write(xml)

        assertNotNull(text)
        assert(text.contains("db.example")) { "connection host was not written to XML:\n$text" }
    }
}
