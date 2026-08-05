package com.rahulmahadik.asksql.ide.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.wm.ToolWindowManager
import com.rahulmahadik.asksql.ide.ui.AskSqlToolWindowFactory

/** Editor context-menu action: opens the AskSQL chat with the current editor selection pre-filled as the question. */
class AskAboutSelectionAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selection = editor.selectionModel.selectedText ?: return
        com.rahulmahadik.asksql.ide.ui.PendingQuestion.set(project, selection)
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("AskSQL") ?: return
        val chatContent = toolWindow.contentManager.contents.firstOrNull { it.getUserData(AskSqlToolWindowFactory.CHAT_PANEL_KEY) != null }
        toolWindow.show()
        chatContent?.let { content ->
            toolWindow.contentManager.setSelectedContent(content)
            // Content is created once and reused, so the pending question is consumed explicitly here.
            content.getUserData(AskSqlToolWindowFactory.CHAT_PANEL_KEY)?.consumePendingQuestion()
        }
    }
}
