package com.rahulmahadik.asksql.ide.db

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.mongodb.client.MongoClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Owns the lifecycle of every configured [MongoClient] for a project. */
@Service(Service.Level.PROJECT)
class MongoClientRegistry(private val project: Project, private val scope: CoroutineScope) : Disposable {

    private val log = logger<MongoClientRegistry>()

    private class Slot(val generation: Int, val deferred: Deferred<MongoClient>) {
        val leases = AtomicInteger(0)
        @Volatile var superseded = false
        @Volatile var closed = false
    }

    private val slots = ConcurrentHashMap<String, Slot>()
    private val generations = ConcurrentHashMap<String, AtomicInteger>()

    /** Runs [block] with a live client for [descriptor]; the only supported way to touch a client. */
    suspend fun <T> withClient(descriptor: ConnectionDescriptor, password: String?, block: suspend (MongoClient) -> T): T {
        val generation = generations.getOrPut(descriptor.id) { AtomicInteger(0) }.get()
        while (true) {
            // compute() runs its remapping function at most once per key, so concurrent racers share one open.
            val slot = slots.compute(descriptor.id) { _, current ->
                if (current != null && current.generation == generation) current
                else newSlot(descriptor, password, generation)
            }!!

            val client = try {
                slot.deferred.await()
            } catch (e: Exception) {
                // Drop the failed slot so the next call opens a fresh attempt.
                slots.remove(descriptor.id, slot)
                throw e
            }
            slot.leases.incrementAndGet()
            // MongoClient has no public isClosed(), hence the explicit flag.
            if (slot.superseded && slot.closed) {
                slot.leases.decrementAndGet()
                continue
            }
            try {
                return block(client)
            } finally {
                if (slot.leases.decrementAndGet() == 0 && slot.superseded) {
                    closeQuietly(slot, client)
                }
            }
        }
    }

    private fun newSlot(descriptor: ConnectionDescriptor, password: String?, generation: Int) = Slot(
        generation = generation,
        deferred = scope.async(Dispatchers.IO) {
            log.info("Opening AskSQL MongoDB client ${descriptor.id}")
            MongoClientFactory.open(descriptor, password)
        },
    )

    /** Bumps the generation so the next [withClient] rebuilds it. If still leased, the lease holder closes it on completion instead of closing here. */
    fun invalidate(connectionId: String) {
        generations.getOrPut(connectionId) { AtomicInteger(0) }.incrementAndGet()
        val slot = slots.remove(connectionId) ?: return
        slot.superseded = true
        if (slot.leases.get() == 0) {
            closeNowOrCancel(slot)
        }
    }

    fun invalidateAll() {
        slots.keys.toList().forEach { invalidate(it) }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun closeNowOrCancel(slot: Slot) {
        if (slot.deferred.isCompleted) {
            // getCompleted() rethrows on a failed open, which would abort closeAll() before the rest.
            val client = try { slot.deferred.getCompleted() } catch (e: Throwable) { return }
            closeQuietly(slot, client)
        } else {
            slot.deferred.cancel()
        }
    }

    private fun closeQuietly(slot: Slot, client: MongoClient) {
        slot.closed = true
        try {
            client.close()
        } catch (e: Exception) {
            log.warn("Error closing AskSQL MongoDB client", e) // never Logger.error, which surfaces a Fatal Error dialog
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
