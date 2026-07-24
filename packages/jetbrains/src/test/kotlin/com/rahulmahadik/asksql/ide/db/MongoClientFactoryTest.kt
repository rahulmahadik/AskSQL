package com.rahulmahadik.asksql.ide.db

import org.junit.Assert.assertTrue
import org.junit.Test

/** [MongoClientFactory.connectFailureMessage] turns a raw driver error into actionable guidance. */
class MongoClientFactoryTest {

    @Test fun `an auth error explains the credentials and the placeholder brackets`() {
        val m = MongoClientFactory.connectFailureMessage("Command failed: bad auth", isAtlas = true)
        assertTrue("got: $m", m.contains("username/password") && m.contains("angle brackets"))
    }

    @Test fun `an Atlas connection failure points at Network Access`() {
        // A TLS handshake alert is exactly what Atlas returns for a non-allow-listed IP.
        val m = MongoClientFactory.connectFailureMessage("tlsv1 alert internal error", isAtlas = true)
        assertTrue("got: $m", m.contains("Network Access"))
    }

    @Test fun `a non-Atlas host failure gives the plain host hint, not Atlas`() {
        val m = MongoClientFactory.connectFailureMessage("connection refused", isAtlas = false)
        assertTrue("got: $m", m.contains("host/port") && !m.contains("Network Access"))
    }
}
