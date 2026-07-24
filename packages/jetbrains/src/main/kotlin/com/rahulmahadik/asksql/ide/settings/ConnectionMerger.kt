package com.rahulmahadik.asksql.ide.settings

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope

/**
 * Merges application-scoped and project-scoped connection descriptors by [ConnectionDescriptor.id].
 * A project connection with the same id as an app-level one shadows it entirely (never merges fields).
 */
object ConnectionMerger {

    private val LOG = Logger.getInstance(ConnectionMerger::class.java)

    data class MergedConnection(val descriptor: ConnectionDescriptor, val shadowsAppLevel: Boolean)

    /** Skips a stored connection whose engine string can't parse instead of throwing and taking down every other connection with it. Also used by [ConnectionsConfigurable]. */
    internal fun List<ConnectionState>.toDescriptorsSkippingInvalid(scope: ConnectionScope): List<ConnectionDescriptor> =
        mapNotNull { state ->
            try {
                state.toDescriptor(scope)
            } catch (e: IllegalArgumentException) {
                LOG.warn("AskSQL: skipping unparsable stored connection '${state.id}' (${state.name}): ${e.message}")
                null
            }
        }

    fun merged(project: Project): List<MergedConnection> {
        val appConnections = AskSqlAppSettings.getInstance().connections.toDescriptorsSkippingInvalid(ConnectionScope.APPLICATION)
        val projectConnections = AskSqlProjectSettings.getInstance(project).connections.toDescriptorsSkippingInvalid(ConnectionScope.PROJECT)
        val projectIds = projectConnections.map { it.id }.toSet()

        val fromApp = appConnections.filterNot { it.id in projectIds }.map { MergedConnection(it, shadowsAppLevel = false) }
        val fromProject = projectConnections.map { MergedConnection(it, shadowsAppLevel = it.id in appConnections.map { a -> a.id }) }
        return fromApp + fromProject
    }

    fun find(project: Project, connectionId: String): ConnectionDescriptor? =
        merged(project).firstOrNull { it.descriptor.id == connectionId }?.descriptor
}
