package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors packages/core/test/nested-aggregate.test.ts; the two must agree. */
class NestedAggregateTest {

    /** Reported by a real question: AVG over a SUM is rejected by every engine. */
    @Test fun `flags an aggregate inside another aggregate`() {
        val sql = "SELECT c.country, AVG(o.freight + SUM(od.unit_price)) AS v FROM orders o " +
            "JOIN customers c ON o.customer_id = c.customer_id JOIN order_details od ON o.order_id = od.order_id " +
            "GROUP BY c.country"
        assertEquals("AVG", Semantics.nestedAggregate(sql))
    }

    @Test fun `allows aggregates side by side`() {
        assertNull(Semantics.nestedAggregate("SELECT SUM(a), AVG(b) FROM t"))
    }

    @Test fun `allows an aggregate over an expression`() {
        assertNull(Semantics.nestedAggregate("SELECT SUM(a * b + 1) FROM t"))
    }

    @Test fun `returns null for unparsable sql rather than blocking`() {
        assertNull(Semantics.nestedAggregate("NOT SQL AT ALL"))
    }

    /** A subquery has its own scope, so its aggregate is not nested in the outer call. */
    @Test fun `allows an aggregate inside a subquery argument`() {
        assertNull(Semantics.nestedAggregate("SELECT SUM((SELECT COUNT(*) FROM u WHERE u.id = t.id)) FROM t"))
    }

    @Test fun `flags nesting in HAVING`() {
        assertEquals("SUM", Semantics.nestedAggregate("SELECT a FROM t GROUP BY a HAVING SUM(COUNT(b)) > 1"))
    }

    @Test fun `flags nesting in ORDER BY`() {
        assertEquals("AVG", Semantics.nestedAggregate("SELECT a FROM t GROUP BY a ORDER BY AVG(SUM(b))"))
    }
}
