package com.rahulmahadik.asksql.ide.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.rahulmahadik.asksql.ide.AskSqlEngineService
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.DriverProvisioner
import com.rahulmahadik.asksql.ide.db.DuckDbFileLoader
import com.rahulmahadik.asksql.ide.errors.ErrorPresenter
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.settings.AskSqlProjectSettings
import com.rahulmahadik.asksql.ide.settings.ConnectionMerger
import com.rahulmahadik.asksql.ide.settings.toState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties

/**
 * Loads user-picked data files (CSV/JSON/NDJSON/Parquet/XLSX/portable .sql) into a DuckDB database
 * via [DuckDbFileLoader]: a fresh connection, or more tables added to an existing DuckDB connection.
 */
class UploadFileToDuckDbAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val descriptor = dataFileChooserDescriptor()
            .withTitle("Choose Data Files to Query")
            .withDescription("Select one or more data files to load as tables. Pick several to query and join across them.")
        val files = FileChooser.chooseFiles(descriptor, project, chooserStartDir(project))
        if (files.isEmpty()) return

        val rejected = unsupported(files.map { it.path })
        if (rejected.isNotEmpty()) {
            Messages.showErrorDialog(
                project,
                unsupportedMessage(rejected),
                "Query Data Files",
            )
            return
        }

        val existing = ConnectionMerger.merged(project).map { it.descriptor }
            .filter { it.engine == EngineKind.DUCKDB && it.filePath != null }
        if (existing.isEmpty()) {
            uploadFiles(project, files.map { it.path }, target = null) {}
            return
        }
        val options = arrayOf("A new set of data files") + existing.map { it.name }.toTypedArray()
        // showChooseDialog is deprecated with no non-deprecated modal list equivalent; the Plugin
        // Verifier accepts it as Compatible, and the alternatives (async popup, N buttons) are worse.
        @Suppress("DEPRECATION")
        val choice = Messages.showChooseDialog(
            project, "Add these ${files.size} file(s) to which set of data files?", "Query Data Files",
            null, options, options[0],
        )
        if (choice < 0) return
        uploadFiles(project, files.map { it.path }, target = if (choice == 0) null else existing[choice - 1]) {}
    }

    companion object {
        /** Data-file formats DuckDB can load directly (see [DuckDbFileLoader]). TSV/TXT go through read_csv_auto, which sniffs the delimiter. */
        val ALLOWED_EXTENSIONS = setOf("csv", "tsv", "txt", "json", "ndjson", "parquet", "xlsx", "xls", "sql")

        /**
         * Deliberately unfiltered multi-select. Every descriptor-level filter tried here made one
         * unsupported file in the selection silently disable OK with no explanation; picking freely
         * and reporting unsupported files afterwards is the behaviour users can actually act on.
         */
        fun dataFileChooserDescriptor(): FileChooserDescriptor =
            FileChooserDescriptor(true, false, false, false, false, true)

        /** A stale remembered selection the current filter rejects makes the chooser fail to reopen; an explicit start directory avoids that. */
        fun chooserStartDir(project: Project) =
            project.basePath?.let { com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(it) }

        /** Names any picked file the loader cannot handle, so an unsupported pick fails with a clear message instead of a driver error. */
        fun unsupported(paths: List<String>): List<String> =
            paths.filter { java.io.File(it).extension.lowercase() !in ALLOWED_EXTENSIONS }.map { java.io.File(it).name }

        /** Says which files were skipped and why, since "OK is greyed out" taught the user nothing. */
        fun unsupportedMessage(rejected: List<String>): String =
            "These aren't data files DuckDB can read as tables, so I left them out:\n" +
                rejected.joinToString("\n") { "  - $it" } +
                "\n\nSupported: ${ALLOWED_EXTENSIONS.sorted().joinToString(", ")}.\n" +
                "Formats like .md or .pdf hold prose, not rows and columns, so there's no table to build from them."

        private fun sanitizedBaseName(sourcePath: String): String {
            val base = java.io.File(sourcePath).nameWithoutExtension.replace(Regex("""[^A-Za-z0-9_-]"""), "_")
            return base.ifBlank { "upload" }
        }

        private fun uniqueDuckDbPath(dir: Path, baseName: String): Path {
            var candidate = dir.resolve("$baseName.duckdb")
            var n = 2
            while (Files.exists(candidate)) {
                candidate = dir.resolve("$baseName-$n.duckdb")
                n++
            }
            return candidate
        }

        /** A fresh managed .duckdb path under the plugin's uploads dir, named after the first source file. */
        fun newManagedDbPath(firstSourcePath: String): Path {
            val dir = Path.of(PathManager.getSystemPath(), "asksql", "uploads")
            Files.createDirectories(dir)
            return uniqueDuckDbPath(dir, sanitizedBaseName(firstSourcePath))
        }

        /** Loads every file into the DuckDB database at [dbPath] (created if absent), returning the table names it made. Blocking JDBC; call off the EDT. */
        suspend fun loadFilesInto(dbPath: Path, sourcePaths: List<String>): List<String> {
            val driver = DriverProvisioner.duckDbDriver()
            return driver.connect("jdbc:duckdb:$dbPath", Properties())!!.use { connection ->
                sourcePaths.flatMap { path ->
                    DuckDbFileLoader.loadFile(connection, path, tableNameHint = sanitizedBaseName(path))
                }
            }
        }

        /** [target] is an existing DuckDB connection to add these files to, or null to create a fresh one holding all of them. */
        fun uploadFiles(project: Project, sourcePaths: List<String>, target: ConnectionDescriptor? = null, onDone: () -> Unit) {
            if (sourcePaths.isEmpty()) return
            AskSqlEngineService.getInstance(project).projectScope.launch(Dispatchers.IO) {
                var managedDbPath: Path? = null
                try {
                    val dbPath = if (target != null) {
                        Path.of(target.filePath!!)
                    } else {
                        newManagedDbPath(sourcePaths.first()).also { managedDbPath = it }
                    }
                    val createdTables = loadFilesInto(dbPath, sourcePaths)

                    val connectionId = target?.id ?: "asksql-upload-${dbPath.fileName}"
                    val connectionName = target?.name ?: if (sourcePaths.size == 1) {
                        "Data file: ${java.io.File(sourcePaths.first()).name}"
                    } else {
                        "Data files: ${sourcePaths.size} files"
                    }
                    if (target == null) {
                        val descriptor = ConnectionDescriptor(
                            id = connectionId, name = connectionName, engine = EngineKind.DUCKDB,
                            scope = ConnectionScope.PROJECT, filePath = dbPath.toString(),
                        )
                        val settings = AskSqlProjectSettings.getInstance(project)
                        settings.connections = settings.connections + descriptor.toState()
                    }
                    project.getService(ConnectionRegistry::class.java).invalidate(connectionId)
                    // An existing connection's cached schema would otherwise miss the new tables for up to 300s.
                    AskSqlEngineService.getInstance(project).pipeline.invalidateCatalogCache()

                    withContext(Dispatchers.Main) {
                        ErrorPresenter.notifyInfo(project, "Loaded ${createdTables.joinToString(", ")} into \"$connectionName\".")
                        ApplicationManager.getApplication().messageBus.syncPublisher(com.rahulmahadik.asksql.ide.settings.AskSqlSettingsListener.TOPIC).settingsChanged()
                        onDone()
                    }
                } catch (ex: Exception) {
                    // A partially written managed database with no connection pointing at it is an orphan.
                    managedDbPath?.let { runCatching { Files.deleteIfExists(it) } }
                    withContext(Dispatchers.Main) { ErrorPresenter.notify(project, ex) }
                }
            }
        }
    }
}
