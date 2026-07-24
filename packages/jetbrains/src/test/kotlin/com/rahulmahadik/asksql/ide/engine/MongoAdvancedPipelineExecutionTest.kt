package com.rahulmahadik.asksql.ide.engine

import com.mongodb.client.MongoClients
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.bson.Document
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.net.Socket
import kotlin.time.Duration.Companion.seconds

/**
 * Proves the advanced stages the guard allows ($lookup, $facet, $bucket, $setWindowFields) execute
 * end to end against a real local MongoDB, with hand-written pipelines: the guard/execution path is under test, not an LLM.
 */
@Category(IntegrationTest::class)
class MongoAdvancedPipelineExecutionTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 57017
        private const val DB = "asksql_demo"
        private const val CUSTOMERS = "advtest_customers"
        private const val ORDERS = "advtest_orders"
    }

    private var mongoAvailable = false

    @Before
    fun setup() {
        mongoAvailable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
        if (!mongoAvailable) return

        MongoClients.create("mongodb://$HOST:$PORT/$DB").use { client ->
            val db = client.getDatabase(DB)
            db.getCollection(CUSTOMERS).drop()
            db.getCollection(ORDERS).drop()
            db.getCollection(CUSTOMERS).insertMany(
                listOf(
                    Document("_id", 1).append("name", "Ava"),
                    Document("_id", 2).append("name", "Ben"),
                ),
            )
            db.getCollection(ORDERS).insertMany(
                listOf(
                    Document("_id", 100).append("customerId", 1).append("totalCents", 5000),
                    Document("_id", 101).append("customerId", 1).append("totalCents", 2000),
                    Document("_id", 102).append("customerId", 2).append("totalCents", 9000),
                ),
            )
        }
    }

    @After
    fun cleanup() {
        if (!mongoAvailable) return
        MongoClients.create("mongodb://$HOST:$PORT/$DB").use { client ->
            client.getDatabase(DB).getCollection(CUSTOMERS).drop()
            client.getDatabase(DB).getCollection(ORDERS).drop()
        }
    }

    private fun descriptor() = ConnectionDescriptor(
        id = "mongo-advanced-test", name = "advanced-test", engine = EngineKind.MONGODB, scope = ConnectionScope.PROJECT,
        database = DB, connectionString = "mongodb://$HOST:$PORT/$DB",
    )

    private fun pipeline() = MongoEnginePipeline(MongoClientRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))

    private fun cells(rs: com.rahulmahadik.asksql.ide.model.AskSqlResultSet): List<List<Any?>> = rs.rows.map { row ->
        row.map { c ->
            when (c) {
                is CellValue.Null -> null
                is CellValue.Text -> c.value
                is CellValue.Number -> c.value
                is CellValue.Boolean -> c.value
                is CellValue.ExactNumeric -> c.value
                is CellValue.Binary -> "BINARY"
            }
        }
    }

    @Test
    fun `dollar-lookup joins customers to their orders and computes a total`() = runTest(timeout = 60.seconds) {
        assumeTrue("MongoDB is not reachable on localhost:$PORT", mongoAvailable)
        val pipelineJson = """
            [
              {"${'$'}lookup": {"from": "$ORDERS", "localField": "_id", "foreignField": "customerId", "as": "orders"}},
              {"${'$'}project": {"_id": 0, "name": 1, "total": {"${'$'}sum": "${'$'}orders.totalCents"}}},
              {"${'$'}sort": {"name": 1}}
            ]
        """.trimIndent()

        val result = pipeline().execute(pipelineJson, CUSTOMERS, descriptor(), password = null)
        val rows = cells(result)
        assertEquals(listOf(listOf("Ava", 7000.0), listOf("Ben", 9000.0)), rows)
    }

    @Test
    fun `dollar-facet runs two independent sub-pipelines in one query`() = runTest(timeout = 60.seconds) {
        assumeTrue("MongoDB is not reachable on localhost:$PORT", mongoAvailable)
        val pipelineJson = """
            [
              {"${'$'}facet": {
                "byCustomerCount": [{"${'$'}count": "n"}],
                "revenue": [{"${'$'}group": {"_id": null, "total": {"${'$'}sum": "${'$'}totalCents"}}}]
              }}
            ]
        """.trimIndent()

        val result = pipeline().execute(pipelineJson, ORDERS, descriptor(), password = null)
        assertEquals(1, result.rows.size)
        val columnNames = result.columns.map { it.name }
        assertTrue("expected both facet keys as separate columns, got: $columnNames", columnNames.containsAll(listOf("byCustomerCount", "revenue")))
        val row = result.rows.first()
        val byCustomerCountJson = (row[columnNames.indexOf("byCustomerCount")] as CellValue.Text).value
        val revenueJson = (row[columnNames.indexOf("revenue")] as CellValue.Text).value
        assertTrue("expected the count facet to report 3, got: $byCustomerCountJson", byCustomerCountJson.contains("\"n\":3"))
        assertTrue("expected the revenue facet to sum to 16000, got: $revenueJson", revenueJson.contains("16000"))
    }

    @Test
    fun `dollar-bucket groups orders into price ranges`() = runTest(timeout = 60.seconds) {
        assumeTrue("MongoDB is not reachable on localhost:$PORT", mongoAvailable)
        val pipelineJson = """
            [
              {"${'$'}bucket": {
                "groupBy": "${'$'}totalCents",
                "boundaries": [0, 3000, 6000, 10000],
                "default": "other",
                "output": {"count": {"${'$'}sum": 1}}
              }}
            ]
        """.trimIndent()

        val result = pipeline().execute(pipelineJson, ORDERS, descriptor(), password = null)
        val rows = cells(result)
        // 2000 -> [0,3000), 5000 -> [3000,6000), 9000 -> [6000,10000): three buckets, one order each.
        assertEquals(3, rows.size)
        assertTrue(rows.all { it[1] == 1.0 })
    }

    @Test
    fun `dollar-setWindowFields ranks orders by total within each customer`() = runTest(timeout = 60.seconds) {
        assumeTrue("MongoDB is not reachable on localhost:$PORT", mongoAvailable)
        val pipelineJson = """
            [
              {"${'$'}setWindowFields": {
                "partitionBy": "${'$'}customerId",
                "sortBy": {"totalCents": -1},
                "output": {"rank": {"${'$'}rank": {}}}
              }},
              {"${'$'}sort": {"customerId": 1, "rank": 1}},
              {"${'$'}project": {"_id": 0, "customerId": 1, "totalCents": 1, "rank": 1}}
            ]
        """.trimIndent()

        val result = pipeline().execute(pipelineJson, ORDERS, descriptor(), password = null)
        val rows = cells(result)
        assertEquals(
            listOf(
                listOf(1.0, 5000.0, 1.0),
                listOf(1.0, 2000.0, 2.0),
                listOf(2.0, 9000.0, 1.0),
            ),
            rows,
        )
    }
}
