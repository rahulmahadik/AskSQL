package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Splitter
import com.intellij.openapi.util.Key
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea

/** Registers the AskSQL tool window; Schema and Chat share ONE [com.intellij.ui.content.Content] in a vertical [Splitter], since two would render as a tab strip. */
class AskSqlToolWindowFactory : ToolWindowFactory, DumbAware {

    companion object {
        private val LOG = Logger.getInstance(AskSqlToolWindowFactory::class.java)

        /** Stashed on the tool window's [com.intellij.ui.content.Content] for [com.rahulmahadik.asksql.ide.actions.RefreshSchemaAction]. */
        val SCHEMA_PANEL_KEY: Key<SchemaTreePanel> = Key.create("asksql.schemaPanel")

        /** Stashed on the tool window's [com.intellij.ui.content.Content] for [com.rahulmahadik.asksql.ide.actions.AskAboutSelectionAction]. */
        val CHAT_PANEL_KEY: Key<ChatPanel> = Key.create("asksql.chatPanel")
    }

    /** Title-bar icons; window-wide actions belong here rather than as inline buttons. */
    override fun init(toolWindow: ToolWindow) {
        val actionManager = ActionManager.getInstance()
        toolWindow.setTitleActions(
            listOfNotNull(
                actionManager.getAction("AskSQL.AddConnection"),
                actionManager.getAction("AskSQL.UploadFileToDuckDb"),
                actionManager.getAction("AskSQL.RefreshSchema"),
                actionManager.getAction("AskSQL.OpenSettings"),
            ),
        )
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val contentFactory = ContentFactory.getInstance()

        // Built independently so a failure in one doesn't blank the whole tool window.
        val schemaPanel = try {
            SchemaTreePanel(project)
        } catch (e: Throwable) {
            LOG.error("AskSQL: Schema panel failed to build", e)
            null
        }
        val chatPanel = try {
            ChatPanel(project)
        } catch (e: Throwable) {
            LOG.error("AskSQL: Chat panel failed to build", e)
            null
        }

        val root: JComponent = when {
            schemaPanel != null && chatPanel != null -> Splitter(true, 0.18f).apply {
                firstComponent = schemaPanel.component
                secondComponent = chatPanel.component
            }
            schemaPanel != null -> schemaPanel.component
            chatPanel != null -> chatPanel.component
            else -> errorPanel("AskSQL failed to load - see idea.log for details (search for \"AskSQL:\").")
        }

        val content = contentFactory.createContent(root, "", false)
        content.isCloseable = false
        // Disposer.dispose also frees each panel's child Disposables (messageBus).
        content.setDisposer(Disposable { schemaPanel?.let { Disposer.dispose(it) }; chatPanel?.let { Disposer.dispose(it) } })
        schemaPanel?.let { content.putUserData(SCHEMA_PANEL_KEY, it) }
        chatPanel?.let { content.putUserData(CHAT_PANEL_KEY, it) }
        toolWindow.contentManager.addContent(content)
    }

    private fun errorPanel(message: String): JPanel {
        val text = JTextArea(message)
        text.isEditable = false
        text.lineWrap = true
        text.wrapStyleWord = true
        return JPanel(BorderLayout()).apply { add(JBScrollPane(text), BorderLayout.CENTER) }
    }

    override fun shouldBeAvailable(project: Project): Boolean = true
}
