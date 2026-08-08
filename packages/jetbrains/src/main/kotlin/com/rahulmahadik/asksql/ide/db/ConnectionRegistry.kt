package com.rahulmahadik.asksql.ide.db

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.rahulmahadik.asksql.ide.model.EngineKind
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import java.sql.Connection
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * One lazily-opened [Connection] per [ConnectionDescriptor.id]. [invalidate] never closes a connection an
 * in-flight [withConnection] still uses: each [Slot] tracks a lease count and closes only once the last lease ends.
 */
@Service(Service.Level.PROJECT)
class ConnectionRegistry(private val project: Project, private val scope: CoroutineScope) : Disposable {

    private val log = logger<ConnectionRegistry>()

    private class Slot(val generation: Int, val deferred: Deferred<Connection>) {
        val leases = AtomicInteger(0)
        @Volatile var superseded = false
    }

    private val slots = ConcurrentHashMap<String, Slot>()
    private val generations = ConcurrentHashMap<String, AtomicInteger>()

    /** Runs [block] with a live connection for [descriptor]; the only way callers should touch a connection, so a concurrent [invalidate] can't close it mid-use. */
    suspend fun <T> withConnection(
        descriptor: ConnectionDescriptor,
        password: String?,
        duckDbDriverJarPath: String? = null,
        oracleDriverJarPath: String? = null,
        block: suspend (Connection) -> T,
    ): T {
        while (true) {
            val (slot, connection) = acquire(descriptor, password, duckDbDriverJarPath, oracleDriverJarPath)
            slot.leases.incrementAndGet()
            // invalidate() may have closed the connection between acquire() returning and the lease above; retry instead of using it.
            if (slot.superseded && connection.isClosed) {
                slot.leases.decrementAndGet()
                continue
            }
            try {
                return block(connection)
            } finally {
                if (slot.leases.decrementAndGet() == 0 && slot.superseded) {
                    closeQuietly(connection)
                }
            }
        }
    }

    private suspend fun acquire(descriptor: ConnectionDescriptor, password: String?, duckDbDriverJarPath: String?, oracleDriverJarPath: String?): Pair<Slot, Connection> {
        val generation = generations.getOrPut(descriptor.id) { AtomicInteger(0) }.get()

        while (true) {
            // compute() runs its remapping function at most once per key, so racers for one not-yet-cached id share a single open.
            val slot = slots.compute(descriptor.id) { _, current ->
                if (current != null && current.generation == generation) current
                else newSlot(descriptor, password, duckDbDriverJarPath, oracleDriverJarPath, generation)
            }!!

            val connection = try {
                slot.deferred.await()
            } catch (e: Exception) {
                // Removes the failed slot, so the next call opens a fresh attempt instead of replaying the cached exception.
                slots.remove(descriptor.id, slot)
                throw e
            }
            // DuckDB's isValid() runs a real SELECT; take JdbcExecutor's per-connection lock like any statement.
            val valid = if (descriptor.engine == EngineKind.DUCKDB) {
                JdbcExecutor.withConnectionLock(connection) { isValid(connection) }
            } else {
                isValid(connection)
            }
            if (valid) return slot to connection

            // Removes only this exact stale instance; a replacement another caller already installed is adopted instead.
            if (slots.remove(descriptor.id, slot)) {
                // The dead connection still holds a file descriptor and a JdbcExecutor lock entry; a lease holder closes it on completion instead.
                slot.superseded = true
                if (slot.leases.get() == 0) closeQuietly(connection)
            }
        }
    }

    private fun newSlot(descriptor: ConnectionDescriptor, password: String?, duckDbDriverJarPath: String?, oracleDriverJarPath: String?, generation: Int) = Slot(
        generation = generation,
        deferred = scope.async(Dispatchers.IO) {
            log.info("Opening AskSQL connection ${descriptor.id} (${descriptor.engine})")
            JdbcConnectionFactory.open(descriptor, password, duckDbDriverJarPath, oracleDriverJarPath)
        },
    )

    private fun isValid(connection: Connection): Boolean = try {
        !connection.isClosed && connection.isValid(2)
    } catch (e: Exception) {
        false
    }

    /** Bumps the generation so the next [withConnection] rebuilds it. If still leased, the lease holder closes it on completion instead of closing here. */
    fun invalidate(connectionId: String) {
        generations.getOrPut(connectionId) { AtomicInteger(0) }.incrementAndGet()
        val slot = slots.remove(connectionId) ?: return
        slot.superseded = true
        if (slot.leases.get() == 0) {
            closeNowOrCancel(slot)
        }
        // else: the in-flight withConnection() block's `finally` closes it once its lease count reaches zero.
    }

    fun invalidateAll() {
        slots.keys.toList().forEach { invalidate(it) }
    }

    /** Closes synchronously if already open, cancels otherwise; never dispatched onto [scope], which is itself being cancelled during project close. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun closeNowOrCancel(slot: Slot) {
        if (slot.deferred.isCompleted) {
            // getCompleted() rethrows on a failed open, which would abort closeAll() before the rest.
            val connection = try { slot.deferred.getCompleted() } catch (e: Throwable) { return }
            closeQuietly(connection)
        } else {
            slot.deferred.cancel()
        }
    }

    private fun closeQuietly(connection: Connection) {
        try {
            connection.close()
        } catch (e: Exception) {
            log.warn("Error closing AskSQL connection", e) // expected/recoverable, never Logger.error, which surfaces a Fatal Error dialog
        } finally {
            JdbcExecutor.forgetConnection(connection)
        }
    }

    /** [closeNowOrCancel] is synchronous, so it is safe at dispose time. */
    override fun dispose() {
        closeAll()
    }

    fun closeAll() {
        slots.keys.toList().forEach { id ->
            slots.remove(id)?.let {
                it.superseded = true
                closeNowOrCancel(it)
            }
        }
    }
}
