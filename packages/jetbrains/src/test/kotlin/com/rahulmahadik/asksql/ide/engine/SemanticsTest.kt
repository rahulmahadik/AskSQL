package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Kotlin half of core's `semantics.test.ts`. This shape is rejected by PostgreSQL and strict
 * MySQL, and silently returns one arbitrary row in SQLite, so it is never the answer asked for.
 */
class SemanticsTest {

    @Test
    fun `an aggregate beside a bare column with no GROUP BY is caught`() {
        assertEquals("status", Semantics.ungroupedAggregate("SELECT status, count(*) FROM orders"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT count(*), status FROM orders"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT status, count(*) AS n FROM orders"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT o.status, count(*) FROM orders o"))
        assertEquals("region", Semantics.ungroupedAggregate("SELECT region, avg(total_cents) FROM orders"))
    }

    /** The negatives matter as much: a false positive costs a repair round on a correct query. */
    @Test
    fun `correct SQL is left alone`() {
        for (sql in listOf(
            "SELECT status, count(*) FROM orders GROUP BY status",
            "SELECT count(*) FROM orders",
            "SELECT sum(total_cents) FROM orders",
            "SELECT status FROM orders",
            "SELECT * FROM orders",
            "SELECT status, count(*) OVER (PARTITION BY status) FROM orders",
            "SELECT id, sum(total_cents) OVER (ORDER BY placed_at) AS running FROM orders",
            "SELECT status FROM orders WHERE total_cents > (SELECT avg(total_cents) FROM orders)",
            "SELECT count(DISTINCT customer_id) FROM orders",
        )) {
            assertNull("expected no complaint: $sql", Semantics.ungroupedAggregate(sql))
        }
    }

    /**
     * The bare column can hide inside any expression. An earlier version listed the handful of
     * expression classes it knew and walked straight past a CASE, an IN list or a BETWEEN.
     */
    @Test
    fun `a bare column is found inside any expression`() {
        assertEquals("status", Semantics.ungroupedAggregate("SELECT CASE WHEN status = 'paid' THEN 1 ELSE 0 END, count(*) FROM orders"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT status IN ('paid','shipped'), count(*) FROM orders"))
        assertEquals("total_cents", Semantics.ungroupedAggregate("SELECT total_cents BETWEEN 1 AND 100, count(*) FROM orders"))
        assertEquals("shipped_at", Semantics.ungroupedAggregate("SELECT shipped_at IS NULL, count(*) FROM orders"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT NOT (status = 'paid'), count(*) FROM orders"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT upper(status), count(*) FROM orders"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT coalesce(status, 'unknown'), count(*) FROM orders"))
    }

    /** Each arm of a UNION is its own query, and each is checked like a standalone one. */
    @Test
    fun `a UNION arm is checked on its own`() {
        assertEquals(
            "status",
            Semantics.ungroupedAggregate(
                "SELECT status, count(*) FROM orders_2025 GROUP BY status UNION ALL SELECT status, count(*) FROM orders_2026",
            ),
        )
        assertNull(
            Semantics.ungroupedAggregate(
                "SELECT status, count(*) FROM orders_2025 GROUP BY status UNION ALL SELECT status, count(*) FROM orders_2026 GROUP BY status",
            ),
        )
    }

    @Test
    fun `unparsable SQL is never reported on`() {
        assertNull(Semantics.ungroupedAggregate("SELECT status count(*) FROM orders GROUP BY"))
        assertNull(Semantics.ungroupedAggregate("not sql at all"))
    }

    /**
     * ExpressionList implements both Expression and Iterable. Matched as an Expression it is
     * opaque, and a middle function argument was reachable only through JDK 21's
     * ArrayList.getFirst()/getLast() - so the walk silently depended on the JDK version.
     */
    @Test
    fun `a middle function argument is reachable`() {
        assertEquals("status", Semantics.ungroupedAggregate("SELECT concat('[', status, ']'), count(*) FROM orders"))
        assertEquals("a", Semantics.ungroupedAggregate("SELECT coalesce(a, status, b), count(*) FROM orders"))
    }

    /** A parenthesized arm is still an arm. */
    @Test
    fun `a parenthesized select is checked`() {
        assertEquals("status", Semantics.ungroupedAggregate("(SELECT status, count(*) FROM a) UNION ALL (SELECT status, count(*) FROM b)"))
        assertEquals("status", Semantics.ungroupedAggregate("(SELECT status, count(*) FROM orders)"))
    }

    /** SQLite's two-argument max/min is a per-row scalar, and FILTER is not a window. */
    @Test
    fun `scalar max and FILTER aggregates are told apart`() {
        assertNull(Semantics.ungroupedAggregate("SELECT name, max(score1, score2) FROM results"))
        assertNull(Semantics.ungroupedAggregate("SELECT name, min(a, b) FROM t"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT status, max(total) FROM orders"))
        assertEquals("status", Semantics.ungroupedAggregate("SELECT status, count(*) FILTER (WHERE paid) FROM orders"))
    }

}
