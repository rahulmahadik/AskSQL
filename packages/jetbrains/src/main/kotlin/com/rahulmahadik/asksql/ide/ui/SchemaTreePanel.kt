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
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
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
    /** Serializes reloads; Refresh lives as the tool window's own title-bar icon (see AskSqlToolWindowFactory). */
    private val reloads = ReloadCoalescer()

    /** Carries the descriptor on a connection node so a right-click can act on it; [toString] is the label the tree renders. */
    private class ConnectionNode(val descriptor: ConnectionDescriptor, private val label: String) {
        override fun toString() = label
    }

    /** Carries the table so the row can act on it; the label is what the tree renders. */
    private class TableNode(val table: TableInfo, val connectionId: String, private val label: String) {
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
                    is TableNode -> showTableMenu(info.table, info.connectionId, e)
                    else -> return
                }
            }
        })
    }

    private fun showTableMenu(table: TableInfo, connectionId: String, e: java.awt.event.MouseEvent) {
        val menu = javax.swing.JPopupMenu()
        menu.add(javax.swing.JMenuItem("Ask About This Table").apply { addActionListener { askAbout(table, connectionId) } })
        menu.show(tree, e.x, e.y)
    }

    /** Seeds the chat with a question about this table, the same handoff Ask About Selection uses. */
    private fun askAbout(table: TableInfo, connectionId: String) {
        val name = table.schema?.let { "$it.${table.name}" } ?: table.name
        seedQuestion("Show me 10 rows from $name", connectionId)
    }

    /** The chat answers against its own selection, so the tree points it at the node clicked. */
    private fun seedQuestion(question: String, connectionId: String) {
        PendingQuestion.set(project, question)
        val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("AskSQL") ?: return
        val chatContent = toolWindow.contentManager.contents
            .firstOrNull { it.getUserData(AskSqlToolWindowFactory.CHAT_PANEL_KEY) != null }
        toolWindow.show()
        chatContent?.let { content ->
            toolWindow.contentManager.setSelectedContent(content)
            val chat = content.getUserData(AskSqlToolWindowFactory.CHAT_PANEL_KEY)
            chat?.selectConnection(connectionId)
            chat?.consumePendingQuestion()
        }
    }

    private fun showConnectionMenu(descriptor: ConnectionDescriptor, e: java.awt.event.MouseEvent) {
        val menu = javax.swing.JPopupMenu()
        menu.add(
            javax.swing.JMenuItem("Describe This Database").apply {
                addActionListener { describeDatabase(descriptor) }
            },
        )
        menu.addSeparator()
        menu.add(
            javax.swing.JMenuItem("Refresh Schema").apply {
                addActionListener { reload(forceRefresh = true, onlyConnectionId = descriptor.id) }
            },
        )
        menu.add(javax.swing.JMenuItem("Edit Connection…").apply { addActionListener { editConnection(descriptor) } })
        menu.addSeparator()
        menu.add(javax.swing.JMenuItem("Delete Connection…").apply { addActionListener { deleteConnection(descriptor) } })
        menu.show(tree, e.x, e.y)
    }

    /**
     * Seeds the overview question, which the engine answers from the WHOLE catalog rather than a
     * term-pruned handful of tables. Discoverability only: nobody guesses to type this.
     */
    private fun describeDatabase(descriptor: ConnectionDescriptor) {
        seedQuestion("What is this database about, how are the tables related, and how many tables are there?", descriptor.id)
    }

    private fun editConnection(descriptor: ConnectionDescriptor) {
        val dialog = ConnectionEditorDialog(project, descriptor)
        val updated = dialog.showAndGetDescriptor() ?: return
        // Secret first, config second, synchronously off the disposable scope.
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
        // Runs synchronously off the disposable scope.
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
        // Drops only this connection's schema cache (both pipelines, since an edit can move the id
        // between engines). Clearing every id would make the reload below re-introspect all of them.
        AskSqlEngineService.getInstance(project).let {
            it.pipeline.invalidateCatalogCache(descriptor.id)
            it.mongoPipeline.invalidateCatalogCache(descriptor.id)
        }
        ApplicationManager.getApplication().messageBus.syncPublisher(AskSqlSettingsListener.TOPIC).settingsChanged()
    }

    /** @param onlyConnectionId re-read just this connection; the others render from cache. */
    fun reload(forceRefresh: Boolean, onlyConnectionId: String? = null) {
        if (!reloads.begin(forceRefresh)) return
        val descriptors = ConnectionMerger.merged(project).map { it.descriptor }
        if (descriptors.isEmpty()) {
            tree.model = DefaultTreeModel(DefaultMutableTreeNode("No connections yet - use \"Add Connection\" to get started."))
            reloads.finish(runFollowUp = true)?.let { reload(forceRefresh = it) }
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
            try {
                // Each connection loads concurrently and updates the tree as it finishes; supervisorScope keeps one failure from cancelling its siblings.
                supervisorScope {
                    descriptors.mapIndexed { index, descriptor ->
                        launch {
                            val refreshThisOne = forceRefresh && (onlyConnectionId == null || descriptor.id == onlyConnectionId)
                            nodes[index] = loadConnectionNode(descriptor, refreshThisOne)
                            ApplicationManager.getApplication().invokeLater {
                                tree.model = DefaultTreeModel(renderRoot())
                                TreeUtil.expand(tree, 1)
                            }
                        }
                    }.joinAll()
                }
            } finally {
                // In a finally: the busy flag clears even when a load fails.
                val cancelled = !coroutineContext.isActive
                ApplicationManager.getApplication().invokeLater {
                    if (forceRefresh && !cancelled) {
                        val loaded = nodes.filterNotNull()
                        val tables = loaded.sumOf { node -> tableCount(node) }
                        // A connection that could not be read renders an error child instead of groups.
                        val failed = descriptors.size - loaded.count { tableCount(it) > 0 || hasEmptyMarker(it) }
                        val suffix = if (failed > 0) " ($failed could not be read)" else ""
                        com.intellij.openapi.wm.WindowManager.getInstance().getStatusBar(project)
                            ?.info = "AskSQL: schema refreshed - $tables tables across ${descriptors.size} connection(s)$suffix"
                    }
                    reloads.finish(runFollowUp = !cancelled)?.let { reload(forceRefresh = it) }
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
            if (tables.isNotEmpty()) connectionNode.add(kindGroupNode("Tables", tables, descriptor.id))
            if (views.isNotEmpty()) connectionNode.add(kindGroupNode("Views", views, descriptor.id))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // the tool window is closing/disposing; must propagate, not render a tree node for it
        } catch (e: Exception) {
            val presented = ErrorPresenter.present(e)
            connectionNode.add(DefaultMutableTreeNode("(could not load schema: ${presented.userMessage})"))
        }
        return connectionNode
    }

    /** Tables and views rendered under one connection node, for the post-refresh status message. */
    private fun tableCount(connectionNode: DefaultMutableTreeNode): Int =
        connectionNode.breadthFirstEnumeration().asSequence().count { (it as? DefaultMutableTreeNode)?.userObject is TableNode }

    /** True for a connection that read its schema and genuinely has nothing in it, as opposed to one that failed. */
    private fun hasEmptyMarker(connectionNode: DefaultMutableTreeNode): Boolean =
        connectionNode.breadthFirstEnumeration().asSequence().any { (it as? DefaultMutableTreeNode)?.userObject == "No tables found" }

    /** Group label carries the count ("Tables (12)"), and each table its column count. */
    private fun kindGroupNode(label: String, tables: List<TableInfo>, connectionId: String): DefaultMutableTreeNode {
        val group = DefaultMutableTreeNode("$label (${tables.size})")
        for (table in tables) {
            val schemaPrefix = table.schema?.let { "$it · " } ?: ""
            val colCount = table.columns.size
            val tableNode = DefaultMutableTreeNode(
                TableNode(table, connectionId, "${table.name} - $schemaPrefix$colCount col${if (colCount == 1) "" else "s"}"),
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

/**
 * Serializes schema reloads: one runs at a time and later requests fold into a single follow-up
 * that keeps the strongest refresh asked for. Not synchronized; every call is made from the EDT.
 */
internal class ReloadCoalescer {
    private var loading = false
    private var pending = false
    private var pendingForce = false

    /** True when the caller should start a load; false when it was folded into the running one. */
    fun begin(forceRefresh: Boolean): Boolean {
        if (loading) {
            pending = true
            pendingForce = pendingForce || forceRefresh
            return false
        }
        loading = true
        return true
    }

    /** Clears the busy flag unconditionally and returns the follow-up's refresh flag, or null if there is none. */
    fun finish(runFollowUp: Boolean): Boolean? {
        loading = false
        val force = pendingForce
        val followUp = pending && runFollowUp
        pending = false
        pendingForce = false
        return if (followUp) force else null
    }
}
