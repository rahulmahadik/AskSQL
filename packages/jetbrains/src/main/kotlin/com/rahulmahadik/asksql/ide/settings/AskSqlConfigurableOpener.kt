package com.rahulmahadik.asksql.ide.settings

import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project

/** Small helper so onboarding empty-state links don't need to know Configurable class names directly. */
object AskSqlConfigurableOpener {
    fun open(project: Project) {
        ShowSettingsUtil.getInstance().showSettingsDialog(project, AskSqlConfigurable::class.java)
    }

    fun openWithLocalModelHint(project: Project) {
        AskSqlConfigurable.pendingLocalModelHint = true
        open(project)
    }
}
