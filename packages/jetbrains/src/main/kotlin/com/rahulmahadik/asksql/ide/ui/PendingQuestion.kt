package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key

/** Hands off editor-selection text from [com.rahulmahadik.asksql.ide.actions.AskAboutSelectionAction] to [ChatPanel] via project user data, scoped to the project's lifetime. */
object PendingQuestion {
    private val KEY = Key.create<String>("AskSQL.PendingQuestion")

    fun set(project: Project, text: String) {
        project.putUserData(KEY, text)
    }

    /** Reads and clears the pending question, if any. */
    fun consume(project: Project): String? {
        val value = project.getUserData(KEY)
        project.putUserData(KEY, null)
        return value
    }
}
