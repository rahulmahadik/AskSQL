package com.rahulmahadik.asksql.ide.model

/**
 * Stage markers emitted during [com.rahulmahadik.asksql.ide.engine.EnginePipeline.ask].
 * Matches the VS Code extension's `ChatStreamEvent` stages, plus `token` (rendered here, unlike VS Code).
 */
enum class Stage { CATALOG, PRUNE, LLM, REPAIR, EXTRACT, GUARD, EXECUTE, DONE }

/**
 * Engine lifecycle events streamed to the UI so the EDT can render each one as it arrives.
 * A sealed interface keeps `when` on [EngineEvent] exhaustive: a new event kind is a compile error, not a silent no-op.
 */
sealed interface EngineEvent {
    data class StageEvent(val stage: Stage, val detail: String? = null) : EngineEvent
    data class Token(val text: String) : EngineEvent
    data class Warning(val message: String) : EngineEvent
    data object Done : EngineEvent
}

fun interface EngineEventListener {
    fun onEvent(event: EngineEvent)
}
