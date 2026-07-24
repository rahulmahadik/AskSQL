package com.rahulmahadik.asksql.ide.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.wm.ToolWindowManager
import com.rahulmahadik.asksql.ide.ui.AskSqlToolWindowFactory

/** Re-introspects every configured connection's schema, bypassing the 300s catalog cache. Wired to the Schema tab's Refresh button; also exposed as an action for the palette/shortcuts. */
class RefreshSchemaAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("AskSQL") ?: return
        val schemaContent = toolWindow.contentManager.contents.firstOrNull { it.getUserData(AskSqlToolWindowFactory.SCHEMA_PANEL_KEY) != null }
        toolWindow.show()
        schemaContent?.let { content ->
            toolWindow.contentManager.setSelectedContent(content)
            content.getUserData(AskSqlToolWindowFactory.SCHEMA_PANEL_KEY)?.reload(forceRefresh = true)
        }
    }
}
