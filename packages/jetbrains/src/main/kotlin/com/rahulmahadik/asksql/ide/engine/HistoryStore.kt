package com.rahulmahadik.asksql.ide.engine

import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

enum class HistoryStatus { OK, BLOCKED, ERROR, CANCELLED }

data class HistoryEntry(
    val id: String,
    val at: Instant,
    val connectionId: String,
    val question: String?,
    val sql: String,
    val status: HistoryStatus,
    val errorCode: String? = null,
    val durationMs: Long? = null,
    val rowCount: Int? = null,
)

/**
 * Audit trail for executed statements. Deliberately in-memory only and bounded: history is
 * never written to disk, since questions and generated SQL can reveal schema/business structure.
 */
interface HistoryStore {
    fun add(entry: HistoryEntry)
    fun recent(limit: Int = 200): List<HistoryEntry>
    fun clear()
}

class InMemoryHistoryStore(private val capacity: Int = 500) : HistoryStore {
    private val entries = CopyOnWriteArrayList<HistoryEntry>()

    override fun add(entry: HistoryEntry) {
        entries.add(entry)
        while (entries.size > capacity) {
            entries.removeAt(0)
        }
    }

    override fun recent(limit: Int): List<HistoryEntry> = entries.takeLast(limit)

    override fun clear() = entries.clear()
}

fun newHistoryId(): String = java.util.UUID.randomUUID().toString()
