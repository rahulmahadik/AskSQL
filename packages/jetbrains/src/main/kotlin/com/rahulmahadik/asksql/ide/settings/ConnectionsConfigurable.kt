package com.rahulmahadik.asksql.ide.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.ToolbarDecorator
import com.intellij.ui.components.JBList
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.settings.ConnectionMerger.toDescriptorsSkippingInvalid
import com.rahulmahadik.asksql.ide.ui.ConnectionEditorDialog
import com.rahulmahadik.asksql.ide.util.runBlockingWithProgress
import javax.swing.DefaultListModel
import javax.swing.JComponent
import javax.swing.JPanel

/** Project-level Configurable: this project's own connections (app-level connections are read-only here, edit those from the application Configurable). */
class ConnectionsConfigurable(private val project: Project) : Configurable {

    private val model = DefaultListModel<ConnectionDescriptor>()
    private var previouslyKnownIds: Set<String> = emptySet()
    /** Snapshot taken by [reset], compared against the live list in [isModified] for native Apply-button behavior (greyed out until something really changed). */
    private var savedSnapshot: List<ConnectionDescriptor> = emptyList()

    /**
     * Passwords entered in Add/Edit are staged here and flushed to PasswordSafe only from [apply],
     * so Cancelling the Settings dialog doesn't leave an orphaned or overwritten keychain entry.
     */
    private val pendingPasswords = mutableMapOf<String, String>()

    override fun getDisplayName(): String = "AskSQL Connections"

    override fun createComponent(): JComponent {
        loadFromSettings()

        val list = JBList(model)
        // A bare DefaultListCellRenderer() calls ConnectionDescriptor's data-class toString()
        // (host/user/id and all); this must render descriptor.name instead.
        list.cellRenderer = object : javax.swing.DefaultListCellRenderer() {
            override fun getListCellRendererComponent(
                list: javax.swing.JList<*>?, value: Any?, index: Int, isSelected: Boolean, cellHasFocus: Boolean,
            ): java.awt.Component {
                val label = (value as? ConnectionDescriptor)?.name ?: value?.toString().orEmpty()
                return super.getListCellRendererComponent(list, label, index, isSelected, cellHasFocus)
            }
        }

        val decorator = ToolbarDecorator.createDecorator(list)
            .setAddAction {
                val dialog = ConnectionEditorDialog(project, null)
                val descriptor = dialog.showAndGetDescriptor() ?: return@setAddAction
                model.addElement(descriptor)
                dialog.enteredPassword?.let { pwd -> pendingPasswords[descriptor.id] = pwd }
            }
            .setEditAction {
                val index = list.selectedIndex
                if (index < 0) return@setEditAction
                val current = model.getElementAt(index)
                val dialog = ConnectionEditorDialog(project, current)
                val updated = dialog.showAndGetDescriptor() ?: return@setEditAction
                model.setElementAt(updated, index)
                dialog.enteredPassword?.let { pwd -> pendingPasswords[updated.id] = pwd }
            }
            .setRemoveAction {
                val index = list.selectedIndex
                if (index < 0) return@setRemoveAction
                val removed = model.getElementAt(index)
                val confirmed = com.intellij.openapi.ui.Messages.showYesNoDialog(
                    "Remove connection \"${removed.name}\"?",
                    "Remove Connection",
                    com.intellij.openapi.ui.Messages.getQuestionIcon(),
                ) == com.intellij.openapi.ui.Messages.YES
                if (!confirmed) return@setRemoveAction
                model.removeElementAt(index)
                pendingPasswords.remove(removed.id)
            }

        val panel = JPanel(java.awt.BorderLayout())
        panel.add(decorator.createPanel(), java.awt.BorderLayout.CENTER)
        return panel
    }

    private fun loadFromSettings() {
        val stored = AskSqlProjectSettings.getInstance(project).connections.toDescriptorsSkippingInvalid(ConnectionScope.PROJECT)
        previouslyKnownIds = stored.map { it.id }.toSet()
        savedSnapshot = stored
        model.clear()
        stored.forEach { model.addElement(it) }
    }

    private fun currentList(): List<ConnectionDescriptor> = (0 until model.size).map { model.getElementAt(it) }

    /** Real dirtiness check (not a hardcoded `true`) so the native Settings dialog's Apply button behaves normally, enabled only once a connection is actually added, edited, or removed. */
    override fun isModified(): Boolean = currentList() != savedSnapshot || pendingPasswords.isNotEmpty()

    /** Reverts the on-screen list to the last-saved connections, invoked by the Settings dialog on Cancel/reopen. Without this the list would keep showing in-progress, un-applied edits. */
    override fun reset() {
        loadFromSettings()
        pendingPasswords.clear()
    }

    override fun apply() {
        val descriptors = currentList()
        val newIds = descriptors.map { it.id }.toSet()
        // Secrets before the config commit, so a failed keychain write leaves the connection list untouched.
        if (pendingPasswords.isNotEmpty()) {
            val toWrite = pendingPasswords.toMap()
            runBlockingWithProgress(project, "Saving connection passwords", cancellable = false) {
                toWrite.forEach { (id, pwd) ->
                    descriptors.find { it.id == id }?.let { AskSqlSecrets.setDbPassword(it, pwd) }
                }
                AskSqlSecrets.pruneOrphaned(newIds, previouslyKnownIds)
            }
            pendingPasswords.clear()
        } else {
            runBlockingWithProgress(project, "Updating connections", cancellable = false) {
                AskSqlSecrets.pruneOrphaned(newIds, previouslyKnownIds)
            }
        }
        AskSqlProjectSettings.getInstance(project).connections = descriptors.map { it.toState() }
        previouslyKnownIds = newIds
        savedSnapshot = descriptors
        // Every cache keyed by connection id must be dropped together: editing a connection's
        // host/database while keeping the same id would otherwise leave a stale JDBC connection,
        // MongoClient, or up to 300s of cached schema serving the old target.
        project.getService(com.rahulmahadik.asksql.ide.db.ConnectionRegistry::class.java).invalidateAll()
        project.getService(com.rahulmahadik.asksql.ide.db.MongoClientRegistry::class.java).invalidateAll()
        project.getService(com.rahulmahadik.asksql.ide.AskSqlEngineService::class.java).let {
            it.pipeline.invalidateCatalogCache()
            it.mongoPipeline.invalidateCatalogCache()
        }
        // Refreshes an already-open Chat tab's connection combo/onboarding state even when this
        // page was opened via the IDE Settings menu, not the Chat tab's own buttons.
        ApplicationManager.getApplication().messageBus.syncPublisher(AskSqlSettingsListener.TOPIC).settingsChanged()
    }
}
