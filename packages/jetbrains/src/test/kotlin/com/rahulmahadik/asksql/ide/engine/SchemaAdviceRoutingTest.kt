package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin half of core's `schema-advice-routing.test.ts`, case for case. A divergence means the
 * plugin answers "how do I improve this schema" with a table listing while other surfaces answer in prose.
 */
class SchemaAdviceRoutingTest {

    private val advice = listOf(
        // Both phrasings that produced `SELECT table_name FROM information_schema.tables`.
        "can you check if i wants improve db schema what are the possiblities",
        "can you please review the db schema and tell me to improve relations between tables what needs to update",
        "how can I improve the relationships between these tables",
        "review my schema and suggest indexes",
        "what is wrong with this database structure",
        "should I normalize the customers table",
        "any problems with my foreign keys",
        "what needs to be fixed in this schema",
        "how can I improve the performance of this query",
        "which indexes should I add to speed up these joins",
        "this query is slow, how do I optimize it",
        "recommend a partitioning strategy for the orders table",
        "is my data model missing any constraints",
        "suggest better indexing for the join between orders and customers",
        "tune the database for faster reads",
        "audit the schema design",
        // Beyond "write me a query": the rest of what people bring to an AI about a database.
        "why is this query slow",
        "explain this query to me",
        "convert this MySQL query to Postgres",
        "rewrite this query without a subquery",
        "what is the difference between a view and a materialized view in this schema",
        "when should I use a composite index here",
        "pros and cons of denormalizing this table",
        "document the schema for a new developer",
        "why does this query return duplicate rows",
        "pros and cons of denormalizing order_items",
        "should I denormalize order_items",
        "how would I partition the largest tables",
        // A description of the whole database, not a table list.
        "describe the schema",
        "can you give details about this db",
        "give me details about the db schema",
        "tell me about this database",
        "give me an overview of this database",
        "explain the schema to me",
        "walk me through the data model",
        "high-level details of this db",
        "what is the best index strategy for filtering orders by status and date",
        "how do I make this join faster between products, inventory and warehouses",
    )

    private val writes = listOf(
        "write a statement that deletes cancelled orders",
        "write a query that removes old rows",
        "give me a SQL command to drop the archive table",
        "generate a migration to add a status column",
        "how do I write a query to update prices",
        "draft a script that truncates the staging table",
        "I need a statement to insert a new customer",
    )

    private val notWrites = listOf(
        "how many orders were deleted last week",
        "show me the cancelled orders",
        "which customers were added in January",
        "what is the total revenue",
    )

    private val listings = listOf(
        "show me all the tables",
        "list the columns in orders",
        "how many tables are there",
        "what views exist in this database",
    )

    private val data = listOf(
        "how many orders were placed last week",
        "total revenue by region",
        "which customers have no orders",
        "which region performed better last quarter",
        "show me the slowest delivery times",
        "why is revenue down this month",
        "which customers explain most of our revenue",
        "which product has the best margin",
    )

    @Test
    fun `advice questions route to prose`() {
        for (q in advice) {
            assertTrue(
                "expected advice: $q",
                EnginePipeline.isSchemaAdviceQuestion(q) || EnginePipeline.isDatabaseOverviewQuestion(q),
            )
            assertFalse("expected not a listing: $q", EnginePipeline.isMetadataQuestion(q))
        }
    }

    @Test
    fun `write requests route to a proposal`() {
        for (q in writes) assertTrue("expected a write request: $q", EnginePipeline.isWriteRequest(q))
        for (q in notWrites) assertFalse("expected not a write request: $q", EnginePipeline.isWriteRequest(q))
    }

    @Test
    fun `listing questions still get a catalog query`() {
        for (q in listings) {
            assertTrue("expected a listing: $q", EnginePipeline.isMetadataQuestion(q))
            assertFalse(
                "expected not advice: $q",
                EnginePipeline.isSchemaAdviceQuestion(q) || EnginePipeline.isDatabaseOverviewQuestion(q),
            )
        }
    }

    @Test
    fun `ordinary data questions are left to SQL generation`() {
        for (q in data) {
            assertFalse("expected not advice: $q", EnginePipeline.isSchemaAdviceQuestion(q))
            assertFalse("expected not a write request: $q", EnginePipeline.isWriteRequest(q))
        }
    }

    /** A proposal answers under the DDL prompt and skips the unknown-reference repair pass, so describing what already exists must not classify as one. */
    @Test
    fun `describing an existing object is advice but not a proposal`() {
        assertTrue(EnginePipeline.isSchemaAdviceQuestion("explain the archive table"))
        for (q in listOf("explain the archive table", "walk me through the shards", "take a look at the partition table")) {
            assertFalse("expected not a proposal: $q", EnginePipeline.isSchemaProposalQuestion(q))
        }
        for (q in listOf("how would I partition the largest tables", "suggest an archive table for old orders")) {
            assertTrue("expected a proposal: $q", EnginePipeline.isSchemaProposalQuestion(q))
        }
    }

    @Test
    fun `each predicate needs both of its halves`() {
        assertFalse(EnginePipeline.isSchemaAdviceQuestion("how can I improve my sales"))
        assertFalse(EnginePipeline.isSchemaAdviceQuestion("how many columns does orders have"))
        assertFalse(EnginePipeline.isWriteRequest("orders can be deleted by an admin"))
        assertFalse(EnginePipeline.isWriteRequest("write a query that counts orders"))
    }

    /** Verbatim shape of a real reply: the model hedged, then offered a consolation catalog query. */
    @Test
    fun `the IMPOSSIBLE sentinel never travels with the query it hedged`() {
        val reply = """
            IMPOSSIBLE: The provided schema does not include a client_transactions table.

            ```sql
            SELECT table_name FROM information_schema.tables
            ```
        """.trimIndent()
        val extraction = Extract.extractSql(reply)
        assertTrue(extraction!!.sql.contains("SELECT table_name"))
        assertFalse(extraction.explanation.contains("IMPOSSIBLE", ignoreCase = true))
    }

    @Test
    fun `an ordinary description survives untouched`() {
        val reply = "Counts the orders per customer.\n```sql\nSELECT customer_id, count(*) FROM orders GROUP BY 1\n```"
        assertTrue(Extract.extractSql(reply)!!.explanation == "Counts the orders per customer.")
    }
}
