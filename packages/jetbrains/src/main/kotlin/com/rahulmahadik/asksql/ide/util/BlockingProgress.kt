package com.rahulmahadik.asksql.ide.util

import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import kotlinx.coroutines.runBlocking
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Daemon so a leaked, still-running blocking call (a driver that ignores its own timeout, a hung NFS mount) never keeps the JVM/IDE process alive on its own. */
private val EXECUTOR = Executors.newCachedThreadPool { r -> Thread(r, "AskSQL-blocking-progress").apply { isDaemon = true } }

/**
 * Runs [action] under a native modal progress dialog until it finishes, is cancelled, or [timeoutMs] elapses.
 * Bounded via `Future.get(timeout)`, not `withTimeout` (which never bounds a genuinely blocking call); a non-cooperative task leaks a daemon thread instead of hanging the caller.
 */
fun <T> runBlockingWithProgress(
    project: Project?,
    title: String,
    cancellable: Boolean = true,
    timeoutMs: Long = 30_000,
    action: suspend () -> T,
): T {
    val future = EXECUTOR.submit<T> { runBlocking { action() } }
    var result: T? = null
    var failure: Throwable? = null
    ProgressManager.getInstance().runProcessWithProgressSynchronously(
        {
            val deadline = System.currentTimeMillis() + timeoutMs
            pollLoop@ while (true) {
                try {
                    result = future.get(200, TimeUnit.MILLISECONDS)
                    break@pollLoop
                } catch (e: TimeoutException) {
                    if (cancellable) {
                        try {
                            ProgressManager.checkCanceled()
                        } catch (cancelled: ProcessCanceledException) {
                            future.cancel(true)
                            failure = cancelled
                            break@pollLoop
                        }
                    }
                    if (System.currentTimeMillis() >= deadline) {
                        future.cancel(true)
                        failure = TimeoutException("AskSQL: operation timed out after ${timeoutMs}ms: $title")
                        break@pollLoop
                    }
                } catch (e: java.util.concurrent.ExecutionException) {
                    failure = e.cause ?: e
                    break@pollLoop
                } catch (e: Throwable) {
                    failure = e
                    break@pollLoop
                }
            }
        },
        title,
        cancellable,
        project,
    )
    failure?.let { throw it }
    @Suppress("UNCHECKED_CAST")
    return result as T
}
