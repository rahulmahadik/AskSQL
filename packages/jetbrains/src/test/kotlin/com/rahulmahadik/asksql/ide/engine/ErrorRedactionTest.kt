package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the redaction tests in packages/core: a cell value must never reach a prompt. */
class ErrorRedactionTest {

    @Test
    fun `strips values a driver quotes back`() {
        val leaks = listOf(
            "Key (email)=(ada@example.com) already exists." to "ada@example.com",
            "invalid input syntax for type integer: \"SECRET\"" to "SECRET",
            "date/time field value out of range: \"2024-99-99\"" to "2024-99-99",
            "invalid input value for enum mood: \"SECRETMOOD\"" to "SECRETMOOD",
            "Failing row contains (1, ada@example.com, 42)." to "ada@example.com",
            "ORA-01722: invalid number: SECRETNUM" to "SECRETNUM",
        )
        for ((raw, secret) in leaks) {
            assertFalse(raw, ErrorRedaction.redactValuesInError(raw).contains(secret))
        }
    }

    @Test
    fun `keeps the identifiers the repair loop needs`() {
        val keep = listOf(
            "column \"emial\" does not exist" to "emial",
            "Unknown column 'emial' in field list" to "emial",
            "no such table: custmers" to "custmers",
        )
        for ((raw, name) in keep) {
            assertTrue(raw, ErrorRedaction.redactValuesInError(raw).contains(name))
        }
    }
}
