package com.rahulmahadik.asksql.ide.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.wm.ToolWindowManager
import com.rahulmahadik.asksql.ide.ui.AskSqlToolWindowFactory

/** Clears the transcript and the follow-up context. */
class ClearChatAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("AskSQL") ?: return
        toolWindow.contentManager.contents
            .firstNotNullOfOrNull { it.getUserData(AskSqlToolWindowFactory.CHAT_PANEL_KEY) }
            ?.clearConversation()
    }
}
