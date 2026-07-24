package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.ui.EditorTextField
import com.rahulmahadik.asksql.ide.actions.OpenSqlInScratchAction
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.datatransfer.StringSelection
import javax.swing.JButton
import javax.swing.JPanel

/**
 * Read-only query display: an [EditorTextField] over a platform file type ("sql" or "json"), giving
 * real syntax highlighting when the host IDE bundles that language and plain text otherwise (SQL on IDEA Community).
 */
class SqlBlockPanel(private val project: Project, sql: String, fileExtension: String = "sql", languageId: String = "SQL") {

    val component: JPanel = JPanel(BorderLayout())
    val sqlText: String = sql

    init {
        val fileType = FileTypeManager.getInstance().getFileTypeByExtension(fileExtension)
        val field = EditorTextField(sql, project, fileType)
        field.setOneLineMode(false)
        field.isViewer = true
        field.setFontInheritedFromLAF(false)
        // Soft-wrap so one long line doesn't force the whole transcript to scroll horizontally.
        field.addSettingsProvider { editor -> editor.settings.isUseSoftWraps = true }
        component.add(field, BorderLayout.CENTER)

        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
        toolbar.add(JButton("Copy").apply { addActionListener { copyToClipboard() } })
        toolbar.add(
            JButton("Open in Scratch").apply {
                addActionListener { OpenSqlInScratchAction.open(project, sqlText, "asksql-query.$fileExtension", languageId) }
            },
        )
        component.add(toolbar, BorderLayout.SOUTH)
    }

    fun copyToClipboard() {
        CopyPasteManager.getInstance().setContents(StringSelection(sqlText))
    }
}
