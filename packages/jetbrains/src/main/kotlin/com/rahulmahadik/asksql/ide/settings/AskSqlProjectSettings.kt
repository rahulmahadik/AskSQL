package com.rahulmahadik.asksql.ide.settings

import com.intellij.openapi.components.SerializablePersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.project.Project

private const val CURRENT_STATE_VERSION = 1

/** Project-scoped connection descriptors only, never a password or API key (see [com.rahulmahadik.asksql.ide.settings.AskSqlSecrets]). */
data class AskSqlProjectState(
    @JvmField val stateVersion: Int = CURRENT_STATE_VERSION,
    @JvmField val connections: List<ConnectionState> = emptyList(),
)

@Service(Service.Level.PROJECT)
@State(name = "AskSqlProjectSettings", storages = [Storage("asksql.xml")])
class AskSqlProjectSettings : SerializablePersistentStateComponent<AskSqlProjectState>(migrate(AskSqlProjectState())) {

    companion object {
        fun getInstance(project: Project): AskSqlProjectSettings = project.getService(AskSqlProjectSettings::class.java)

        private fun migrate(loaded: AskSqlProjectState): AskSqlProjectState = when (loaded.stateVersion) {
            CURRENT_STATE_VERSION -> loaded
            else -> loaded.copy(stateVersion = CURRENT_STATE_VERSION)
        }
    }

    /** The constructor argument only seeds defaults; migrating the persisted state needs this hook. */
    override fun loadState(state: AskSqlProjectState) = super.loadState(migrate(state))

    var connections: List<ConnectionState>
        get() = state.connections
        set(value) { updateState { it.copy(connections = value) } }
}
