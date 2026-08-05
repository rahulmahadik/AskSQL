package com.rahulmahadik.asksql.ide.util

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.runInterruptible
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Daemon so a leaked, still-running blocking call never keeps the JVM/IDE process alive on its own. */
private val EXECUTOR = Executors.newCachedThreadPool { r -> Thread(r, "AskSQL-hard-timeout").apply { isDaemon = true } }

/**
 * Non-UI counterpart to [runBlockingWithProgress]'s `Future.get` timeout, for blocking calls reached
 * from a coroutine with no real bound of their own. A stuck [block] leaks its daemon thread rather than hanging the caller.
 */
suspend fun <T> withHardTimeout(timeoutMs: Long, block: suspend () -> T): T {
    val future = EXECUTOR.submit<T> { runBlocking { block() } }
    try {
        // runInterruptible so a caller cancel (Stop) interrupts the blocked get and fires block()'s cancellation hooks.
        return runInterruptible(Dispatchers.IO) {
            try {
                future.get(timeoutMs, TimeUnit.MILLISECONDS)
            } catch (e: TimeoutException) {
                future.cancel(true)
                throw TimeoutException("AskSQL: operation timed out after ${timeoutMs}ms")
            } catch (e: ExecutionException) {
                throw e.cause ?: e
            }
        }
    } catch (e: CancellationException) {
        future.cancel(true)
        throw e
    }
}
