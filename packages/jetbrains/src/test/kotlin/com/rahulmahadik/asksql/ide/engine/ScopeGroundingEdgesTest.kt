package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.model.ColumnInfo
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.model.TableKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin half of core's `scope-grounding-edges.test.ts`. A divergence between the two engines
 * shows up as the plugin declining something the VS Code extension answers.
 */
class ScopeGroundingEdgesTest {

    private fun column(name: String) = ColumnInfo(name = name, dbType = "text", nullable = true)

    private val catalog = SchemaCatalog(
        engine = EngineKind.POSTGRES,
        schemas = listOf("shop"),
        tables = listOf(
            TableInfo(schema = "shop", name = "orders", kind = TableKind.TABLE, columns = listOf(column("id"), column("customer_id"), column("status"))),
            TableInfo(schema = "shop", name = "customers", kind = TableKind.TABLE, columns = listOf(column("id"), column("name"))),
        ),
    )

    @Test
    fun `the punctuated sentinel is recognised in any case`() {
        assertTrue(Scope.isOffTopic("OUT_OF_SCOPE"))
        assertTrue(Scope.isOffTopic("out-of-scope"))
        assertTrue(Scope.isOffTopic("**OUT_OF_SCOPE**"))
    }

    @Test
    fun `the shouted spaced sentinel is recognised`() {
        assertTrue(Scope.isOffTopic("OUT OF SCOPE"))
    }

    /** "out of scope" is ordinary English; treating it as the marker discarded the answer. */
    @Test
    fun `lower-case English out of scope is not the sentinel`() {
        assertFalse(Scope.isOffTopic("Indexes are out of scope for this question, but shop.orders has one on id."))
        assertFalse(Scope.isOffTopic("That is out of scope here."))
    }

    @Test
    fun `a punctuated sentinel bolted onto a real answer is stripped`() {
        assertTrue(Scope.stripSentinel("OUT_OF_SCOPE shop.orders links to shop.customers").trim() == "shop.orders links to shop.customers")
    }

    @Test
    fun `prose containing the English phrase survives stripping unchanged`() {
        val prose = "Partitioning is out of scope for this answer."
        assertTrue(Scope.stripSentinel(prose) == prose)
    }

    @Test
    fun `a genuine fragment is still degenerate`() {
        assertTrue(Scope.isDegenerateAnswer("OUT_ARGUMENT VARCHAR2"))
        assertTrue(Scope.isDegenerateAnswer("yes"))
    }

    /** CJK writes no spaces, so a whole sentence counted as a single word. */
    @Test
    fun `a complete Japanese sentence is not degenerate`() {
        assertFalse(Scope.isDegenerateAnswer("注文テーブルはcustomer_idで顧客テーブルに紐づきます"))
    }

    @Test
    fun `a complete Russian sentence is not degenerate`() {
        assertFalse(Scope.isDegenerateAnswer("Таблица заказов связана с клиентами"))
    }

    @Test
    fun `a one-word CJK reply is still degenerate`() {
        assertTrue(Scope.isDegenerateAnswer("はい"))
    }

    @Test
    fun `a refusal is recognised with either apostrophe`() {
        assertTrue(Scope.isProseRefusal("I'm sorry, but I can't help with that."))
        assertTrue(Scope.isProseRefusal("I’m sorry, but I can’t help with that."))
    }

    @Test
    fun `a hedged answer naming real schema is not a refusal`() {
        assertFalse(Scope.isProseRefusal("I can't tell from the schema alone, but shop.orders has status.", true))
    }

    @Test
    fun `a real table is recognised, qualified or not`() {
        assertTrue(Grounding.mentionsCatalogName("join shop.orders to shop.customers", catalog))
        assertTrue(Grounding.mentionsCatalogName("the orders table", catalog))
        assertTrue(Grounding.mentionsCatalogName("link them on customer_id", catalog))
    }

    /** The catalog has a `name` column, so almost any sentence used to count as schema talk. */
    @Test
    fun `an everyday word behind a generic column name does not count`() {
        assertFalse(Grounding.mentionsCatalogName("My name is on the parcel, thanks for asking.", catalog))
    }

    @Test
    fun `a substring inside a longer word does not count`() {
        assertFalse(Grounding.mentionsCatalogName("You can rename things in a namespace.", catalog))
    }

    /** A bare "with" counted as SQL context, whitelisting the invention the floor exists to catch. */
    @Test
    fun `an invented name after a prose as is still flagged when the answer says with`() {
        val answer = "Along with shop.orders, historical activity is stored as customer_history and linked by customer_id."
        assertTrue(Grounding.unknownReferencesInProse(answer, catalog).contains("customer_history"))
    }

    @Test
    fun `a genuine SQL alias is accepted`() {
        assertTrue(Grounding.unknownReferencesInProse("Run: SELECT count(*) AS order_count FROM shop.orders", catalog).isEmpty())
    }

    @Test
    fun `a CTE the answer itself defines is accepted`() {
        val answer = "Use WITH recent_orders AS (SELECT * FROM shop.orders) SELECT * FROM recent_orders"
        assertTrue(Grounding.unknownReferencesInProse(answer, catalog).isEmpty())
    }

    /**
     * A hand-maintained keyword list is only as good as its coverage, so this is a corpus rather
     * than a spot check - the same sentences core's test uses, so a divergence between the two
     * vocabulary lists shows up here rather than in a user's chat window.
     */
    @Test
    fun `SQL vocabulary in an answer is never reported as an invented name`() {
        val clean = listOf(
            "Use `ROW_NUMBER()` over (partition by customer_id order by id) to pick the latest order.",
            "Group with date_trunc on a timestamp column, then order by the bucket.",
            "You can use string_agg or array_agg to collapse the rows into one value per customer.",
            "A LEFT JOIN keeps customers with no orders; use COALESCE to turn the null into 0.",
            "Add an index on shop.orders(customer_id) - see EXPLAIN for whether it is used.",
            "current_timestamp and now() both work; date_part can pull the month out.",
            "Use a CASE expression with NULLIF to avoid dividing by zero.",
            "The status column is text; CAST it if you need a number.",
            "Filter with WHERE ... IN (...) or an EXISTS subquery on shop.orders.",
            "generate_series can fill missing dates before the LEFT JOIN.",
            "Use `COUNT(*)` with `GROUP BY` and `HAVING` to keep only busy customers.",
            "An order_by on a computed alias works in Postgres.",
        )
        for (answer in clean) {
            val found = Grounding.unknownReferencesInProse(answer, catalog)
            assertTrue("expected no invented names in: $answer, got $found", found.isEmpty())
        }
    }

    @Test
    fun `a backticked placeholder or literal is not a missing name`() {
        for (answer in listOf("Bind the id as `?` and pass it yourself.", "Use `2024-01-01` as the cutoff.", "Pass `:customer_id`.")) {
            val found = Grounding.unknownReferencesInProse(answer, catalog)
            assertTrue("expected nothing flagged in: $answer, got $found", found.isEmpty())
        }
    }

    @Test
    fun `a backticked name that really is missing is still caught`() {
        assertTrue(Grounding.unknownReferencesInProse("Add a `customer_history` table.", catalog).contains("customer_history"))
        assertTrue(Grounding.unknownReferencesInProse("Read `shop.orders` for this.", catalog).isEmpty())
    }

    /** Backticks are how MySQL quotes identifiers, and a hyphen is legal inside them. */
    @Test
    fun `a missing hyphenated name is still caught`() {
        assertTrue(Grounding.unknownReferencesInProse("Check the `order-history` table.", catalog).contains("order-history"))
    }

    /** Java's \s is ASCII-only, unlike JavaScript's. */
    @Test
    fun `a backticked span with a unicode space matches core`() {
        val found = Grounding.unknownReferencesInProse("see `orders summary_view` for details", catalog)
        assertTrue("expected summary_view in $found", found.contains("summary_view"))
    }

    /** The other half of the contract: the stoplist must not have swallowed the floor's real job. */
    @Test
    fun `invented names sitting among SQL vocabulary are still caught`() {
        val answer = "Use ROW_NUMBER() over (partition by customer_id) against customer_history, " +
            "then LEFT JOIN order_archive to get the totals."
        val found = Grounding.unknownReferencesInProse(answer, catalog)
        assertTrue("expected customer_history in $found", found.contains("customer_history"))
        assertTrue("expected order_archive in $found", found.contains("order_archive"))
    }
}
