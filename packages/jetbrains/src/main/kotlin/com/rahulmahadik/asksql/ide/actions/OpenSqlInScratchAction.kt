package com.rahulmahadik.asksql.ide.actions

import com.intellij.ide.scratch.ScratchRootType
import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.PlainTextLanguage
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project

/** Opens SQL text as a scratch file, using the platform's bundled SQL language when available and plain text otherwise. */
object OpenSqlInScratchAction {
    fun open(project: Project, sql: String, fileName: String = "asksql-query.sql", languageId: String = "SQL") {
        val language = Language.findLanguageByID(languageId) ?: PlainTextLanguage.INSTANCE
        val file = ScratchRootType.getInstance().createScratchFile(project, fileName, language, sql)
        if (file != null) FileEditorManager.getInstance(project).openFile(file, true)
    }
}
