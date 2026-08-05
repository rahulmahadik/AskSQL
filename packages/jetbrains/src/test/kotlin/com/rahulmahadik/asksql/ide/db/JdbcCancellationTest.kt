package com.rahulmahadik.asksql.ide.db

import com.rahulmahadik.asksql.ide.model.EngineKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Proxy
import java.sql.Connection
import java.sql.SQLException
import java.sql.Statement
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Stop has to reach the database: [Statement.cancel] runs while `executeQuery` is still blocked,
 * which is the only window in which the server stops working on the query.
 */
class JdbcCancellationTest {

    private val entered = CountDownLatch(1)
    private val cancelled = CountDownLatch(1)

    /** A JDBC connection whose `executeQuery` blocks until `cancel()` arrives from another thread. */
    private fun blockingConnection(): Connection {
        val statement = Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(Statement::class.java),
            InvocationHandler { proxy, method, args ->
                when (method.name) {
                    "executeQuery" -> {
                        entered.countDown()
                        cancelled.await(30, TimeUnit.SECONDS)
                        throw SQLException("query cancelled")
                    }
                    "cancel" -> { cancelled.countDown(); null }
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === args?.firstOrNull()
                    "toString" -> "blocking-statement"
                    else -> null
                }
            },
        ) as Statement
        return Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(Connection::class.java),
            InvocationHandler { proxy, method, args ->
                when (method.name) {
                    "createStatement" -> statement
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === args?.firstOrNull()
                    "toString" -> "blocking-connection"
                    else -> null
                }
            },
        ) as Connection
    }

    @Test
    fun `cancelling the query cancels the statement while executeQuery is still blocked`() = runBlocking {
        val connection = blockingConnection()
        val query = launch(Dispatchers.IO) {
            JdbcExecutor.execute(connection, "SELECT 1", maxRows = 10, timeoutMs = 30_000, engine = EngineKind.POSTGRES)
        }
        try {
            assertTrue("executeQuery never started", entered.await(10, TimeUnit.SECONDS))
            query.cancel()
            assertTrue(
                "Statement.cancel() must run while executeQuery is still blocked, not after it returns",
                cancelled.await(10, TimeUnit.SECONDS),
            )
        } finally {
            cancelled.countDown()
        }
        query.join()
    }
}
