package com.rahulmahadik.asksql.ide.settings

import com.intellij.openapi.components.RoamingType
import com.intellij.openapi.components.SerializablePersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

private const val CURRENT_STATE_VERSION = 1

data class AskSqlAppState(
    @JvmField val stateVersion: Int = CURRENT_STATE_VERSION,
    @JvmField val provider: String = "",
    @JvmField val model: String = "",
    @JvmField val baseUrl: String? = null,
    @JvmField val maxRows: Int = 100,
    /** Token budget for the schema sent to the model (estimate at ~4 chars/token). Higher fits more tables for complex joins; lower keeps prompts small for limited-context models. */
    @JvmField val maxSchemaTokens: Int = 5000,
    @JvmField val requireApproval: Boolean = false,
    /** Auto-generate a plain-language description of each answer (one extra model call per query); the "Explain" button also produces it on demand. */
    @JvmField val explainAutomatically: Boolean = true,
    /** When a question can't become SQL, answer it in prose from the schema (structure only, grounded, invented names flagged) instead of erroring. Off by default. */
    @JvmField val answerSchemaQuestions: Boolean = false,
    @JvmField val connections: List<ConnectionState> = emptyList(),
    /** Appended verbatim after the default system-prompt rules (see [com.rahulmahadik.asksql.ide.engine.Prompts.buildSqlSystem]); the AST guard still enforces read-only regardless. */
    @JvmField val customInstructions: String = "",
)

/**
 * Application-scoped settings: AI provider/model/key selection and global engine defaults.
 * `RoamingType.DISABLED` since this is per-machine data, not something to sync across machines.
 */
@Service(Service.Level.APP)
@State(name = "AskSqlAppSettings", storages = [Storage(value = "asksql.xml", roamingType = RoamingType.DISABLED)])
class AskSqlAppSettings : SerializablePersistentStateComponent<AskSqlAppState>(migrate(AskSqlAppState())) {

    companion object {
        fun getInstance(): AskSqlAppSettings = service()

        /** A future shape change bumps [CURRENT_STATE_VERSION] and adds a case here. */
        private fun migrate(loaded: AskSqlAppState): AskSqlAppState = when (loaded.stateVersion) {
            CURRENT_STATE_VERSION -> loaded
            else -> loaded.copy(stateVersion = CURRENT_STATE_VERSION)
        }
    }

    /** The constructor argument only seeds defaults; migrating the persisted state needs this hook. */
    override fun loadState(state: AskSqlAppState) = super.loadState(migrate(state))

    var provider: String
        get() = state.provider
        set(value) { updateState { it.copy(provider = value) } }

    var model: String
        get() = state.model
        set(value) { updateState { it.copy(model = value) } }

    var baseUrl: String?
        get() = state.baseUrl
        set(value) { updateState { it.copy(baseUrl = value) } }

    var maxRows: Int
        get() = state.maxRows
        set(value) { updateState { it.copy(maxRows = value) } }

    var maxSchemaTokens: Int
        get() = state.maxSchemaTokens
        set(value) { updateState { it.copy(maxSchemaTokens = value) } }

    var requireApproval: Boolean
        get() = state.requireApproval
        set(value) { updateState { it.copy(requireApproval = value) } }

    var explainAutomatically: Boolean
        get() = state.explainAutomatically
        set(value) { updateState { it.copy(explainAutomatically = value) } }

    var answerSchemaQuestions: Boolean
        get() = state.answerSchemaQuestions
        set(value) { updateState { it.copy(answerSchemaQuestions = value) } }

    var connections: List<ConnectionState>
        get() = state.connections
        set(value) { updateState { it.copy(connections = value) } }

    var customInstructions: String
        get() = state.customInstructions
        set(value) { updateState { it.copy(customInstructions = value) } }
}
