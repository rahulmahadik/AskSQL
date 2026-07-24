package com.rahulmahadik.asksql.ide.db

import com.mongodb.client.MongoClients
import com.rahulmahadik.asksql.ide.db.introspect.MongoIntrospector
import com.rahulmahadik.asksql.ide.guard.MongoGuard
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.bson.Document
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import org.testcontainers.containers.MongoDBContainer

/**
 * Proves, against a real MongoDB instance, that introspection produces a correct sampled catalog,
 * query execution marshals BSON correctly, and [MongoGuard] actually rejects a write pipeline.
 * Unlike the JDBC engines, Mongo has no driver/session-level read-only floor underneath the guard.
 */
@Category(IntegrationTest::class)
class MongoIntegrationTest {

    private lateinit var container: MongoDBContainer
    private val databaseName = "asksql_test"

    @Before
    fun startContainer() {
        container = MongoDBContainer("mongo:7.0")
        container.start()
        MongoClients.create(container.getReplicaSetUrl(databaseName)).use { setup ->
            val collection = setup.getDatabase(databaseName).getCollection("customers")
            collection.insertOne(Document("name", "Ava").append("balance", 123456789012L))
            collection.insertMany((1..20).map { Document("seq", it) })
        }
    }

    @After
    fun stopContainer() {
        container.stop()
    }

    private fun descriptor() = ConnectionDescriptor(
        id = "mongo-test", name = "mongo-test", engine = EngineKind.MONGODB, scope = ConnectionScope.PROJECT,
        database = databaseName, connectionString = container.getReplicaSetUrl(databaseName),
    )

    @Test
    fun `real driver connect, introspection, and query execution`() = runTest {
        MongoClientFactory.open(descriptor(), password = null).use { client ->
            val catalog = MongoIntrospector.introspect(client.getDatabase(databaseName))
            val table = catalog.tables.first { it.name == "customers" }
            assertTrue(table.columns.any { it.name == "name" })
            assertTrue(table.columns.any { it.name == "balance" })

            val result = MongoQueryExecutor.execute(
                client.getDatabase(databaseName), "customers",
                listOf(Document("\$match", Document("name", "Ava"))), maxRows = 10, timeoutMs = 5000,
            )
            assertTrue("expected at least one row back", result.rows.isNotEmpty())
        }
    }

    @Test
    fun `int64 balance round-trips as an exact string, never a lossy double`() = runTest {
        MongoClientFactory.open(descriptor(), password = null).use { client ->
            val result = MongoQueryExecutor.execute(
                client.getDatabase(databaseName), "customers",
                listOf(Document("\$match", Document("name", "Ava"))), maxRows = 10, timeoutMs = 5000,
            )
            val balanceIndex = result.columns.indexOfFirst { it.name == "balance" }
            val cell = result.rows.first()[balanceIndex]
            assertTrue("expected ExactNumeric for an int64 balance", cell is CellValue.ExactNumeric)
            assertEquals("123456789012", (cell as CellValue.ExactNumeric).value)
        }
    }

    /**
     * MongoDB has no [ReadOnlySession] analogue to arm, so this proves the guard itself, against a
     * REAL server, is the only thing standing between a generated pipeline and a write.
     */
    @Test
    fun `the guard rejects an out stage that would otherwise write to a real server`() = runTest {
        val verdict = MongoGuard.guard("""[{"${'$'}out": "evil"}]""")
        assertFalse(verdict.allowed)

        // Confirms $out actually WOULD have written, had the guard not
        // caught it; otherwise this test would be proving nothing.
        MongoClientFactory.open(descriptor(), password = null).use { client ->
            val database = client.getDatabase(databaseName)
            database.getCollection("customers").aggregate(listOf(Document("\$out", "evil_control_group"))).toCollection()
            assertTrue(
                "expected the raw driver call itself to actually create the target collection, proving the guard - not MongoDB - is what blocks this",
                database.listCollectionNames().into(mutableListOf()).contains("evil_control_group"),
            )
        }
    }

    /** [MongoQueryExecutor.execute]'s own truncation sentinel - untested apart from the pure BSON-marshaling cases in [MongoQueryExecutorTest]. */
    @Test
    fun `execute truncates to maxRows and reports truncated when more documents are available`() = runTest {
        MongoClientFactory.open(descriptor(), password = null).use { client ->
            val database = client.getDatabase(databaseName)
            database.getCollection("bulk").insertMany((1..10).map { Document("seq", it) })

            val result = MongoQueryExecutor.execute(database, "bulk", emptyList(), maxRows = 3, timeoutMs = 5000)
            assertEquals(3, result.rowCount)
            assertTrue("expected truncated=true when more rows exist than maxRows", result.truncated)
        }
    }

    /** [MongoQueryExecutor.execute]'s column set is the UNION across every returned document, with a missing field rendered as [CellValue.Null] - see the class doc on [MongoQueryExecutor]. */
    @Test
    fun `execute unions columns across heterogeneous documents and nulls out missing fields`() = runTest {
        MongoClientFactory.open(descriptor(), password = null).use { client ->
            val database = client.getDatabase(databaseName)
            database.getCollection("mixed").insertMany(
                listOf(Document("a", 1).append("b", 2), Document("a", 3).append("c", 4)),
            )

            val result = MongoQueryExecutor.execute(database, "mixed", emptyList(), maxRows = 10, timeoutMs = 5000)
            // "_id" rides along on every document by default (no $project excludes it here).
            assertEquals(setOf("_id", "a", "b", "c"), result.columns.map { it.name }.toSet())

            val aIndex = result.columns.indexOfFirst { it.name == "a" }
            val bIndex = result.columns.indexOfFirst { it.name == "b" }
            val cIndex = result.columns.indexOfFirst { it.name == "c" }

            val firstRow = result.rows.first { it[aIndex] == CellValue.Number(1.0) }
            assertEquals(CellValue.Number(2.0), firstRow[bIndex])
            assertEquals("expected the ABSENT 'c' field on the first document to render as Null", CellValue.Null, firstRow[cIndex])

            val secondRow = result.rows.first { it[aIndex] == CellValue.Number(3.0) }
            assertEquals("expected the ABSENT 'b' field on the second document to render as Null", CellValue.Null, secondRow[bIndex])
            assertEquals(CellValue.Number(4.0), secondRow[cIndex])
        }
    }

    /** Same concern as [PostgresJdbcIntegrationTest]'s concurrency test, for MongoDB's client-per-connection registry. */
    @Test
    fun `many concurrent queries against the same shared client each get their own correct result`() = runTest {
        val registry = MongoClientRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val results = (1..20).map { n ->
            async {
                registry.withClient(descriptor(), null) { client ->
                    MongoQueryExecutor.execute(
                        client.getDatabase(databaseName), "customers",
                        listOf(Document("\$match", Document("seq", n)), Document("\$project", Document("_id", 0).append("seq", 1))),
                        maxRows = 1, timeoutMs = 5000,
                    ).rows.first().first().let { it as CellValue.Number }.value
                }
            }
        }.awaitAll()

        assertEquals((1..20).map { it.toDouble() }, results)
    }
}
