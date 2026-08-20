package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.db.introspect.SqliteIntrospector
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.sql.Connection
import java.sql.DriverManager

/**
 * A Room schema states neither the unit of an integer timestamp nor that a TEXT column holds JSON, and
 * both gaps answer 0 with no error: epoch millis compared to a text date matches nothing, and a guessed
 * key matched with LIKE finds nothing. These hints close that, and must do it without stating a value.
 */
class SqliteValueHintTest {

    private fun introspect(ddl: String, nameKeys: Boolean = false): Map<String, String?> {
        Class.forName("org.sqlite.JDBC")
        val c: Connection = DriverManager.getConnection("jdbc:sqlite::memory:")
        c.createStatement().use { st -> ddl.split(";\n").filter { it.isNotBlank() }.forEach { st.execute(it) } }
        val catalog = SqliteIntrospector.introspect(c, nameKeys)
        c.close()
        return catalog.tables.flatMap { t -> t.columns.map { "${t.name}.${it.name}" to it.comment } }.toMap()
    }

    @Test
    fun `an integer timestamp states its unit, which the type never does`() {
        val hints = introspect(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, placed_at INTEGER, seen_at INTEGER);\n" +
                "INSERT INTO orders VALUES (1, 1755300000000, 1755300000)",
        )
        assertEquals("epoch milliseconds", hints["orders.placed_at"])
        assertEquals("epoch seconds", hints["orders.seen_at"])
    }

    @Test
    fun `an id column named like a moment is not called a timestamp`() {
        // Found in a real 65-table schema: created_by_employee_id matches the name test but holds an id.
        // Left alone it would be labelled "epoch seconds" once ids passed 1e8, which misleads the model.
        val hints = introspect(
            "CREATE TABLE t (created_by_employee_id INTEGER, updated_by_employee_id INTEGER, order_no INTEGER, status_code INTEGER);\n" +
                "INSERT INTO t VALUES (1755300000, 1755300000, 1755300000, 1755300000)",
        )
        for (c in listOf("created_by_employee_id", "updated_by_employee_id", "order_no", "status_code")) {
            assertNull("$c was described as a moment: ${hints["t.$c"]}", hints["t.$c"])
        }
    }

    @Test
    fun `an integer that is not a timestamp is left alone`() {
        val hints = introspect("CREATE TABLE t (qty INTEGER, price_cents INTEGER);\nINSERT INTO t VALUES (3, 1999)")
        assertNull(hints["t.qty"])
        assertNull(hints["t.price_cents"])
    }

    @Test
    fun `JSON in a TEXT column counts its recurring keys, and names them only under the opt-in`() {
        // LIKE is what the model reaches for without this, and a single space after a colon defeats it.
        val hints = introspect(
            "CREATE TABLE settings (user_id INTEGER, prefs TEXT);\n" +
                "INSERT INTO settings VALUES (1, '{\"theme\":\"dark\",\"notify\":true}'), " +
                "(2, '{\"theme\":\"light\",\"notify\":false}'), (3, '{\"theme\":\"dark\",\"notify\":true}')",
        )
        val hint = hints["settings.prefs"]
        assertTrue("expected a JSON hint, got $hint", hint != null && hint.contains("json_extract"))
        // A map with a stable key set looks exactly like a record, so the names ride the opt-in.
        assertTrue(hint!!, hint.contains("2 recurring keys"))
        assertTrue("a key leaked without the opt-in: $hint", !hint.contains("theme"))
        assertTrue("a value leaked into the schema: $hint", !hint.contains("dark") && !hint.contains("light"))
    }

    @Test
    fun `nested objects report only the top-level keys`() {
        val row = "'{\"a\":{\"b\":1},\"c\":[1,2],\"d\":\"x:y{\"}'"
        val hints = introspect("CREATE TABLE t (doc TEXT);\nINSERT INTO t VALUES ($row), ($row), ($row)", nameKeys = true)
        val hint = hints["t.doc"]!!
        assertTrue(hint, hint.endsWith("keys: a, c, d"))
    }

    @Test
    fun `a long key list is trimmed at a key boundary, never mid-name`() {
        // CatalogPruner caps a comment at 200 characters and appends an ellipsis; a name cut in half
        // would offer the model a key that does not exist.
        val doc = (0 until 12).joinToString(",") { "\"field_name_$it\":$it" }
        val hints = introspect("CREATE TABLE t (prefs TEXT);\nINSERT INTO t VALUES ('{$doc}'), ('{$doc}'), ('{$doc}')", nameKeys = true)
        val hint = hints["t.prefs"]!!
        assertTrue("hint is ${hint.length} chars: $hint", hint.length <= 200)
        assertTrue(hint, hint.endsWith(", ..."))
        val named = hint.substringAfter("keys: ").split(", ").filter { it != "..." }
        for (k in named) assertTrue("half a name: $k", Regex("^field_name_\\d+$").matches(k))
    }

    @Test
    fun `an identifier-shaped key that is really a username is never named`() {
        // A username passes the field-name test, so shape alone cannot reject it. Reuse can: each key
        // here appears on exactly one row, which is a map, not a record.
        val hints = introspect(
            "CREATE TABLE t (perms TEXT);\n" +
                "INSERT INTO t VALUES ('{\"ZZALICE\":3}'), ('{\"ZZBOB\":7}'), ('{\"ZZCAROL\":1}')",
        )
        val hint = hints["t.perms"]!!
        assertTrue(hint, hint.contains("json_extract")) // the accessor is still worth saying
        for (who in listOf("ZZALICE", "ZZBOB", "ZZCAROL")) assertTrue("$who leaked: $hint", !hint.contains(who))
    }

    @Test
    fun `the key of a single-tenant map recurs but is still data, and is not named`() {
        val hints = introspect(
            "CREATE TABLE t (by_tenant TEXT);\n" +
                "INSERT INTO t VALUES ('{\"ZZACME\":1}'), ('{\"ZZACME\":2}'), ('{\"ZZACME\":3}')",
        )
        assertTrue(hints["t.by_tenant"]!!, !hints["t.by_tenant"]!!.contains("ZZACME"))
    }

    @Test
    fun `a map keyed by user data is not described at all`() {
        // The shape that would turn this hint into a value leak: the keys ARE the data.
        val hints = introspect(
            "CREATE TABLE t (by_user TEXT);\nINSERT INTO t VALUES ('{\"ada@example.com\":3,\"grace@example.com\":5}')",
        )
        assertNull("an address must never reach the schema: ${hints["t.by_user"]}", hints["t.by_user"])
    }

    @Test
    fun `ordinary text and malformed JSON are left alone`() {
        val hints = introspect(
            "CREATE TABLE t (title TEXT, broken TEXT, empty TEXT);\n" +
                "INSERT INTO t VALUES ('Let It Be', '{not json', '{}')",
        )
        assertNull(hints["t.title"])
        assertNull(hints["t.broken"])
        // An empty object is still JSON, so the accessor is offered - but there is no key to name.
        assertTrue(hints["t.empty"] == null || !hints["t.empty"]!!.contains("keys:"))
    }

    @Test
    fun `a column that is JSON in only some rows is not described`() {
        val hints = introspect("CREATE TABLE t (v TEXT);\nINSERT INTO t VALUES ('{\"a\":1}'), ('plain text')")
        assertNull(hints["t.v"])
    }

    @Test
    fun `an empty table costs no probe and yields no hint`() {
        val hints = introspect("CREATE TABLE t (created_at INTEGER, prefs TEXT)")
        assertNull(hints["t.created_at"])
        assertNull(hints["t.prefs"])
    }
}
