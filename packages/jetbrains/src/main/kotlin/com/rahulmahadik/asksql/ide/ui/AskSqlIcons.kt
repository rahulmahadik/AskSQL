package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.util.IconLoader

/** Plugin icons resolved once. The tool window's own chat-bubble icon doubles as the assistant avatar in the transcript. */
object AskSqlIcons {
    val ASSISTANT = IconLoader.getIcon("/icons/toolWindowAskSql.svg", AskSqlIcons::class.java)
}
