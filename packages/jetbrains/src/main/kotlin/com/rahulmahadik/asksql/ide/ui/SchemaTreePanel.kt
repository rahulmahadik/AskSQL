package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.tree.TreeUtil
import com.rahulmahadik.asksql.ide.AskSqlEngineService
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry
import com.rahulmahadik.asksql.ide.errors.ErrorPresenter
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.settings.AskSqlAppSettings
import com.rahulmahadik.asksql.ide.settings.AskSqlProjectSettings
import com.rahulmahadik.asksql.ide.settings.AskSqlSecrets
import com.rahulmahadik.asksql.ide.util.runBlockingWithProgress
import com.rahulmahadik.asksql.ide.settings.AskSqlSettingsListener
import com.rahulmahadik.asksql.ide.settings.ConnectionMerger
import com.rahulmahadik.asksql.ide.settings.toState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import java.awt.BorderLayout
import javax.swing.JPanel
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel

/**
 * Schema browser tree (connection, kind group, table, columns). Tree construction runs on a
 * background coroutine; only the finished [DefaultTreeModel] is handed to the EDT.
 */
class SchemaTreePanel(private val project: Project) : Disposable {

    val component = JPanel(BorderLayout())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val tree = Tree(DefaultMutableTreeNode("AskSQL"))
    /** Guards against overlapping reloads; Refresh lives as the tool window's own title-bar icon (see AskSqlToolWindowFactory). */
    private var isLoading = false
    /** A reload requested while one is in flight runs after it finishes, so a connection edit/delete during a slow load isn't dropped. */
    private var pendingReload = false

    /** Carries the descriptor on a connection node so a right-click can act on it; [toString] is the label the tree renders. */
    private class ConnectionNode(val descriptor: ConnectionDescriptor, private val label: String) {
        override fun toString() = label
    }

    /** Carries the table so the row can act on it; the label is what the tree renders. */
    private class TableNode(val table: TableInfo, private val label: String) {
        override fun toString() = label
    }

    init {
        component.add(JBScrollPane(tree), BorderLayout.CENTER)
        installContextMenu()
        project.messageBus.connect(this).subscribe(AskSqlSettingsListener.TOPIC, AskSqlSettingsListener { reload(forceRefresh = false) })
        reload(forceRefresh = false)
    }

    private fun installContextMenu() {
        tree.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mousePressed(e: java.awt.event.MouseEvent) = maybePopup(e)
            override fun mouseReleased(e: java.awt.event.MouseEvent) = maybePopup(e)
            private fun maybePopup(e: java.awt.event.MouseEvent) {
                if (!e.isPopupTrigger) return
                val path = tree.getPathForLocation(e.x, e.y) ?: return
                val node = path.lastPathComponent as? DefaultMutableTreeNode ?: return
                tree.selectionPath = path
                when (val info = node.userObject) {
                    is ConnectionNode -> showConnectionMenu(info.descriptor, e)
                    is TableNode -> showTableMenu(info.table, e)
                    else -> return
                }
            }
        })
    }

    private fun showTableMenu(table: TableInfo, e: java.awt.event.MouseEvent) {
        val menu = javax.swing.JPopupMenu()
        menu.add(javax.swing.JMenuItem("Ask About This Table").apply { addActionListener { askAbout(table) } })
        menu.show(tree, e.x, e.y)
    }

    /** Seeds the chat with a question about this table, the same handoff Ask About Selection uses. */
    private fun askAbout(table: TableInfo) {
        val name = table.schema?.let { "$it.${table.name}" } ?: table.name
        PendingQuestion.set(project, "Show me 10 rows from $name")
        val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("AskSQL") ?: return
        val chatContent = toolWindow.contentManager.contents
            .firstOrNull { it.getUserData(AskSqlToolWindowFactory.CHAT_PANEL_KEY) != null }
        toolWindow.show()
        chatContent?.let { content ->
            toolWindow.contentManager.setSelectedContent(content)
            content.getUserData(AskSqlToolWindowFactory.CHAT_PANEL_KEY)?.consumePendingQuestion()
        }
    }

    private fun showConnectionMenu(descriptor: ConnectionDescriptor, e: java.awt.event.MouseEvent) {
        val menu = javax.swing.JPopupMenu()
        menu.add(javax.swing.JMenuItem("Refresh Schema").apply { addActionListener { reload(forceRefresh = true) } })
        menu.add(javax.swing.JMenuItem("Edit Connection…").apply { addActionListener { editConnection(descriptor) } })
        menu.addSeparator()
        menu.add(javax.swing.JMenuItem("Delete Connection…").apply { addActionListener { deleteConnection(descriptor) } })
        menu.show(tree, e.x, e.y)
    }

    private fun editConnection(descriptor: ConnectionDescriptor) {
        val dialog = ConnectionEditorDialog(project, descriptor)
        val updated = dialog.showAndGetDescriptor() ?: return
        // Secret before config, synchronously off the disposable scope, so a mid-edit close can't save a connection with no password.
        dialog.enteredPassword?.let { pwd ->
            runBlockingWithProgress(project, "Saving connection password", cancellable = false) {
                AskSqlSecrets.setDbPassword(updated, pwd)
            }
        }
        when (updated.scope) {
            ConnectionScope.PROJECT -> AskSqlProjectSettings.getInstance(project).let { s ->
                s.connections = s.connections.map { if (it.id == updated.id) updated.toState() else it }
            }
            ConnectionScope.APPLICATION -> AskSqlAppSettings.getInstance().let { s ->
                s.connections = s.connections.map { if (it.id == updated.id) updated.toState() else it }
            }
        }
        afterConnectionChange(updated)
    }

    private fun deleteConnection(descriptor: ConnectionDescriptor) {
        val scopeNote = if (descriptor.scope == ConnectionScope.APPLICATION) " It is shared across all your projects." else ""
        val confirmed = com.intellij.openapi.ui.Messages.showYesNoDialog(
            project,
            "Delete connection \"${descriptor.name}\"?$scopeNote\nThe database itself is not affected, only AskSQL's saved connection.",
            "Delete Connection",
            "Delete", "Cancel",
            com.intellij.openapi.ui.Messages.getWarningIcon(),
        ) == com.intellij.openapi.ui.Messages.YES
        if (!confirmed) return
        when (descriptor.scope) {
            ConnectionScope.PROJECT -> AskSqlProjectSettings.getInstance(project).let { s ->
                s.connections = s.connections.filter { it.id != descriptor.id }
            }
            ConnectionScope.APPLICATION -> AskSqlAppSettings.getInstance().let { s ->
                s.connections = s.connections.filter { it.id != descriptor.id }
            }
        }
        // Synchronous off the disposable scope, so dispose can't cancel it and a late removal can't wipe a re-added same-id password.
        runBlockingWithProgress(project, "Removing connection password", cancellable = false) {
            AskSqlSecrets.removeDbPassword(descriptor.id)
        }
        afterConnectionChange(descriptor)
    }

    private fun afterConnectionChange(descriptor: ConnectionDescriptor) {
        if (descriptor.engine == EngineKind.MONGODB) {
            project.getService(MongoClientRegistry::class.java).invalidate(descriptor.id)
        } else {
            project.getService(ConnectionRegistry::class.java).invalidate(descriptor.id)
        }
        // The pipelines' schema caches would otherwise keep serving the old target for up to 300s.
        AskSqlEngineService.getInstance(project).let {
            it.pipeline.invalidateCatalogCache()
            it.mongoPipeline.invalidateCatalogCache()
        }
        ApplicationManager.getApplication().messageBus.syncPublisher(AskSqlSettingsListener.TOPIC).settingsChanged()
    }

    fun reload(forceRefresh: Boolean) {
        if (isLoading) {
            pendingReload = true
            return
        }
        isLoading = true
        val descriptors = ConnectionMerger.merged(project).map { it.descriptor }
        if (descriptors.isEmpty()) {
            tree.model = DefaultTreeModel(DefaultMutableTreeNode("No connections yet - use \"Add Connection\" to get started."))
            isLoading = false
            return
        }

        val nodes = arrayOfNulls<DefaultMutableTreeNode>(descriptors.size)
        fun renderRoot(): DefaultMutableTreeNode {
            val root = DefaultMutableTreeNode("AskSQL")
            descriptors.indices.forEach { i -> root.add(nodes[i] ?: DefaultMutableTreeNode(ConnectionNode(descriptors[i], "${descriptors[i].name} (loading…)"))) }
            return root
        }
        tree.model = DefaultTreeModel(renderRoot())

        scope.launch {
            // Each connection loads concurrently and updates the tree as it finishes, so one slow/broken connection can't block the rest.
            val jobs = descriptors.mapIndexed { index, descriptor ->
                launch {
                    nodes[index] = loadConnectionNode(descriptor, forceRefresh)
                    ApplicationManager.getApplication().invokeLater {
                        tree.model = DefaultTreeModel(renderRoot())
                        TreeUtil.expand(tree, 1)
                    }
                }
            }
            jobs.joinAll()
            ApplicationManager.getApplication().invokeLater {
                isLoading = false
                if (pendingReload) {
                    pendingReload = false
                    reload(forceRefresh = false)
                }
            }
        }
    }

    /** Where the connection points, for display. File engines show the file (or in-memory), not a host:port they don't have. */
    private fun connectionTarget(descriptor: ConnectionDescriptor): String = when (descriptor.engine) {
        EngineKind.SQLITE, EngineKind.DUCKDB -> descriptor.filePath?.takeIf { it.isNotBlank() } ?: "in-memory"
        EngineKind.MONGODB -> descriptor.connectionString.orEmpty()
        else -> "${descriptor.host.orEmpty()}:${descriptor.port ?: "?"}/${descriptor.database ?: "?"}"
    }

    private suspend fun loadConnectionNode(descriptor: ConnectionDescriptor, forceRefresh: Boolean): DefaultMutableTreeNode {
        val target = connectionTarget(descriptor)
        val connectionLabel = "${descriptor.name} - ${descriptor.engine.wireName}${if (target.isNotBlank()) " · $target" else ""}"
        val connectionNode = DefaultMutableTreeNode(ConnectionNode(descriptor, connectionLabel))
        try {
            val password = AskSqlSecrets.getDbPassword(descriptor)
            val engineService = AskSqlEngineService.getInstance(project)
            val catalog = if (descriptor.engine.isSql) {
                engineService.pipeline.catalog(descriptor, password, refresh = forceRefresh)
            } else {
                engineService.mongoPipeline.catalog(descriptor, password, refresh = forceRefresh)
            }
            val tables = catalog.tables.filter { it.kind == com.rahulmahadik.asksql.ide.model.TableKind.TABLE }
            val views = catalog.tables.filter { it.kind != com.rahulmahadik.asksql.ide.model.TableKind.TABLE }
            if (tables.isEmpty() && views.isEmpty()) {
                connectionNode.add(DefaultMutableTreeNode("No tables found"))
            }
            if (tables.isNotEmpty()) connectionNode.add(kindGroupNode("Tables", tables))
            if (views.isNotEmpty()) connectionNode.add(kindGroupNode("Views", views))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // the tool window is closing/disposing; must propagate, not render a tree node for it
        } catch (e: Exception) {
            val presented = ErrorPresenter.present(e)
            connectionNode.add(DefaultMutableTreeNode("(could not load schema: ${presented.userMessage})"))
        }
        return connectionNode
    }

    /** Group label carries the count ("Tables (12)"), and each table its column count. */
    private fun kindGroupNode(label: String, tables: List<TableInfo>): DefaultMutableTreeNode {
        val group = DefaultMutableTreeNode("$label (${tables.size})")
        for (table in tables) {
            val schemaPrefix = table.schema?.let { "$it · " } ?: ""
            val colCount = table.columns.size
            val tableNode = DefaultMutableTreeNode(
                TableNode(table, "${table.name} - $schemaPrefix$colCount col${if (colCount == 1) "" else "s"}"),
            )
            for (column in table.columns) {
                val marker = when {
                    table.primaryKey.contains(column.name) -> " (PK)"
                    table.foreignKeys.any { it.columns.contains(column.name) } -> " (FK)"
                    else -> ""
                }
                tableNode.add(DefaultMutableTreeNode("${column.name}: ${column.dbType}$marker"))
            }
            group.add(tableNode)
        }
        return group
    }

    override fun dispose() {
        scope.cancel()
    }
}
