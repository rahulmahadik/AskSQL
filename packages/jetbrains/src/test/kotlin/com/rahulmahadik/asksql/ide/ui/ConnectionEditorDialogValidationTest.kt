package com.rahulmahadik.asksql.ide.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import com.rahulmahadik.asksql.ide.model.EngineKind
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Direct unit coverage for [ConnectionEditorDialog]'s pure validation logic:
 * [mongoConnectionStringHasEmbeddedCredentials] and [MONGO_SCHEME_RE]. The dialog's other logic
 * needs a real `Project`/`DialogWrapper` fixture this test module isn't set up for.
 */
class ConnectionEditorDialogValidationTest {

    @Test fun `plain mongodb scheme is recognized`() {
        assertTrue(MONGO_SCHEME_RE.containsMatchIn("mongodb://localhost:27017/mydb"))
    }

    @Test fun `mongodb+srv scheme is recognized`() {
        assertTrue(MONGO_SCHEME_RE.containsMatchIn("mongodb+srv://cluster0.example.mongodb.net/mydb"))
    }

    @Test fun `scheme matching is case-insensitive`() {
        assertTrue(MONGO_SCHEME_RE.containsMatchIn("MONGODB://localhost/mydb"))
    }

    @Test fun `a non-mongo scheme is not recognized`() {
        assertFalse(MONGO_SCHEME_RE.containsMatchIn("postgres://localhost/mydb"))
        assertFalse(MONGO_SCHEME_RE.containsMatchIn("localhost:27017/mydb"))
    }

    @Test fun `a passwordless connection string has no embedded credentials`() {
        assertFalse(mongoConnectionStringHasEmbeddedCredentials("mongodb://localhost:27017/mydb"))
        assertFalse(mongoConnectionStringHasEmbeddedCredentials("mongodb+srv://cluster0.example.mongodb.net/mydb"))
    }

    @Test fun `a connection string with embedded user-colon-password is rejected`() {
        assertTrue(mongoConnectionStringHasEmbeddedCredentials("mongodb://user:pass@localhost:27017/mydb"))
    }

    @Test fun `a connection string with embedded user only (no password) is still rejected`() {
        assertTrue(mongoConnectionStringHasEmbeddedCredentials("mongodb://user@localhost:27017/mydb"))
    }

    @Test fun `embedded credentials are detected across a comma-separated multi-host replica-set string too`() {
        assertTrue(mongoConnectionStringHasEmbeddedCredentials("mongodb://user:pass@host1:27017,host2:27017,host3:27017/mydb"))
    }

    @Test fun `an at-sign appearing only in the path or query, after the host, does not count as embedded credentials`() {
        // e.g. a database or option value containing "@"; the check must only look before the first "/".
        assertFalse(mongoConnectionStringHasEmbeddedCredentials("mongodb://localhost:27017/my@db"))
    }

    @Test fun `a string that doesn't even match the mongo scheme is never flagged for embedded credentials`() {
        // The scheme check reports that failure separately; this function must not double-flag it.
        assertFalse(mongoConnectionStringHasEmbeddedCredentials("user:pass@localhost:27017/mydb"))
    }

    // A hidden field that fails validation silently disables OK, so engines without a port must
    // never report a port problem. This regressed once and was invisible in the UI.

    @Test fun `engines without a port accept an empty port`() {
        listOf(EngineKind.DUCKDB, EngineKind.SQLITE, EngineKind.MONGODB).forEach {
            assertNull("$it must not require a port", portValidationMessage(it, ""))
            assertNull("$it must ignore whatever the hidden port field holds", portValidationMessage(it, "not-a-number"))
        }
    }

    @Test fun `host and port engines still validate the port`() {
        listOf(EngineKind.POSTGRES, EngineKind.MYSQL, EngineKind.ORACLE).forEach {
            assertNotNull("$it must reject an empty port", portValidationMessage(it, ""))
            assertNotNull("$it must reject an out-of-range port", portValidationMessage(it, "70000"))
            assertNull("$it must accept a valid port", portValidationMessage(it, "5432"))
        }
    }
}
