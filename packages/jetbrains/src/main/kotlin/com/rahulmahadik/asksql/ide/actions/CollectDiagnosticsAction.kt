package com.rahulmahadik.asksql.ide.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.testFramework.LightVirtualFile
import java.awt.datatransfer.StringSelection
import java.nio.file.Files

/** Bundles plugin/IDE versions and recent AskSQL log lines for bug reports, each line capped at [MAX_LINE_CHARS]. */
class CollectDiagnosticsAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    companion object {
        private const val MAX_LINE_CHARS = 300
    }

    override fun actionPerformed(e: AnActionEvent) {
        val appInfo = ApplicationInfo.getInstance()
        val report = buildString {
            appendLine("AskSQL diagnostics")
            appendLine("IDE: ${appInfo.versionName} ${appInfo.fullVersion} (build ${appInfo.build.asString()})")
            appendLine("OS: ${System.getProperty("os.name")} ${System.getProperty("os.version")}")
            appendLine("JDK: ${System.getProperty("java.version")}")
            appendLine()
            appendLine("Recent AskSQL log lines:")
            appendLine(recentAskSqlLogLines())
        }

        val file = LightVirtualFile("asksql-diagnostics.txt", report)
        e.project?.let { FileEditorManager.getInstance(it).openTextEditor(OpenFileDescriptor(it, file), true) }
        CopyPasteManager.getInstance().setContents(StringSelection(report))
    }

    private fun recentAskSqlLogLines(): String = try {
        val logFile = java.nio.file.Path.of(PathManager.getLogPath(), "idea.log")
        Files.readAllLines(logFile)
            .filter { it.contains("AskSQL") || it.contains("com.rahulmahadik.asksql") }
            .takeLast(200)
            .map { if (it.length > MAX_LINE_CHARS) it.take(MAX_LINE_CHARS) + "…" else it }
            .joinToString("\n")
    } catch (e: Exception) {
        "(could not read idea.log: ${e.message})"
    }
}
