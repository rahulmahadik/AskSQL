package com.rahulmahadik.asksql.ide.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
import com.rahulmahadik.asksql.ide.settings.AskSqlConfigurableOpener

/** Tool-window title-bar icon that opens AskSQL's settings directly. */
class OpenSettingsAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        AskSqlConfigurableOpener.open(project)
    }
}
