package com.rahulmahadik.asksql.ide.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.application.ApplicationManager
import com.rahulmahadik.asksql.ide.settings.AskSqlProjectSettings
import com.rahulmahadik.asksql.ide.settings.AskSqlSecrets
import com.rahulmahadik.asksql.ide.settings.AskSqlSettingsListener
import com.rahulmahadik.asksql.ide.settings.toState
import com.rahulmahadik.asksql.ide.ui.ConnectionEditorDialog
import com.rahulmahadik.asksql.ide.util.runBlockingWithProgress

class AddConnectionAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        showWizard(project) {}
    }

    companion object {
        fun showWizard(project: Project, onAdded: () -> Unit) {
            val dialog = ConnectionEditorDialog(project, null)
            val descriptor = dialog.showAndGetDescriptor() ?: return
            val settings = AskSqlProjectSettings.getInstance(project)
            // Secret before config, so a failed write never leaves a connection persisted with no credential.
            dialog.enteredPassword?.let { pwd ->
                runBlockingWithProgress(project, "Saving connection password", cancellable = false) {
                    AskSqlSecrets.setDbPassword(descriptor, pwd)
                }
            }
            settings.connections = settings.connections + descriptor.toState()
            project.getService(com.rahulmahadik.asksql.ide.db.ConnectionRegistry::class.java).invalidate(descriptor.id)
            ApplicationManager.getApplication().messageBus.syncPublisher(AskSqlSettingsListener.TOPIC).settingsChanged()
            onAdded()
        }
    }
}
