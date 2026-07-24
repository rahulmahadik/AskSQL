package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.test.IntegrationTest
import com.rahulmahadik.asksql.ide.test.fakeProject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.net.Socket
import kotlin.time.Duration.Companion.seconds

/**
 * Proves [MongoEnginePipeline.execute] re-verifies the target collection against the current
 * catalog: MongoDB silently returns zero rows for a nonexistent collection, so without this check
 * a stale/wrong-case name would look identical to "no matching documents".
 */
@Category(IntegrationTest::class)
class MongoExecuteCollectionVerificationLiveTest {

    companion object {
        private const val HOST = "localhost"
        private const val PORT = 57017
        private const val DB = "asksql_demo"
    }

    private var mongoAvailable = false

    @Before
    fun checkMongo() {
        mongoAvailable = try {
            Socket(HOST, PORT).use { true }
        } catch (e: Exception) {
            false
        }
    }

    private fun descriptor(id: String) = ConnectionDescriptor(
        id = id, name = id, engine = EngineKind.MONGODB, scope = ConnectionScope.PROJECT,
        database = DB, connectionString = "mongodb://$HOST:$PORT/$DB",
    )

    private fun pipeline() = MongoEnginePipeline(MongoClientRegistry(fakeProject(), CoroutineScope(SupervisorJob() + Dispatchers.Default)))

    @Test
    fun `execute rejects a collection that doesn't exist instead of silently returning zero rows`() = runTest(timeout = 30.seconds) {
        assumeTrue("MongoDB is not reachable on localhost:$PORT - skipping the live test", mongoAvailable)

        val error = try {
            pipeline().execute(
                pipelineJson = "[{\"\$match\": {}}]",
                collection = "definitely_not_a_real_collection_xyz",
                descriptor = descriptor("mongo-execute-verify-missing"),
                password = null,
            )
            null
        } catch (e: AskSqlException) {
            e
        }
        if (error == null) fail("expected execute() to reject a nonexistent collection, but it returned a result instead")
        assertTrue(error!!.userMessage.contains("doesn't exist"))
    }

    @Test
    fun `execute resolves a real collection given in the wrong case, the same way ask() already does`() = runTest(timeout = 30.seconds) {
        assumeTrue("MongoDB is not reachable on localhost:$PORT - skipping the live test", mongoAvailable)

        // "orders" is a real, lowercase collection in asksql_demo; asking execute() to run against
        // "ORDERS" must resolve to the real casing (Mongo collection names are case-sensitive) rather
        // than throwing OR silently querying a collection that doesn't actually exist.
        val resultSet = pipeline().execute(
            pipelineJson = "[{\"\$match\": {}}]",
            collection = "ORDERS",
            descriptor = descriptor("mongo-execute-verify-casing"),
            password = null,
        )
        assertTrue("expected at least one row back from the real 'orders' collection resolved from 'ORDERS'", resultSet.rows.isNotEmpty())
    }
}
